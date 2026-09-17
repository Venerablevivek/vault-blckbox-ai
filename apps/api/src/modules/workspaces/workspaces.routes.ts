import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireSession } from '../../plugins/session';
import { requireOwner } from '../../policy';
import type { OverviewService } from '../overview/overview.service';
import type { WorkspacesService } from './workspaces.service';

const workspaceParams = z.object({ id: z.string().uuid() });

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { workspaces: WorkspacesService; overview: OverviewService },
): void {
  const { workspaces, overview } = deps;
  const memberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

  // Dashboard data. Any member; the activity slice inside is owner-only.
  app.get('/api/workspaces/:id/overview', { preHandler: requireSession }, async (request) => {
    const { id } = workspaceParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    const { tz } = z.object({ tz: z.string().max(64).optional() }).parse(request.query);
    return { role: membership.role, ...(await overview.forWorkspace(id, membership.role, tz)) };
  });

  app.patch('/api/workspaces/:id', { preHandler: requireSession }, async (request) => {
    const { id } = workspaceParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    requireOwner(membership.role);
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    await workspaces.rename({ workspaceId: id, actor: { id: user.id, role: membership.role }, name });
    return { workspace: { id, name } };
  });

  app.patch('/api/workspaces/:id/members/:userId', { preHandler: requireSession }, async (request, reply) => {
    const { id, userId } = memberParams.parse(request.params);
    const user = currentUser(request);
    // Authorize before reading the body, so a non-member always sees the same 404.
    const membership = await workspaces.requireMember(id, user.id);
    requireOwner(membership.role);
    const { role } = z.object({ role: z.enum(['OWNER', 'MEMBER', 'VIEWER']) }).parse(request.body);
    await workspaces.changeRole({
      workspaceId: id,
      actor: { id: user.id, role: membership.role },
      targetUserId: userId,
      role,
    });
    return reply.status(204).send();
  });

  // Owners remove anyone; anyone may remove themselves (leave).
  app.delete('/api/workspaces/:id/members/:userId', { preHandler: requireSession }, async (request, reply) => {
    const { id, userId } = memberParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    await workspaces.removeMember({
      workspaceId: id,
      actor: { id: user.id, role: membership.role },
      targetUserId: userId,
    });
    return reply.status(204).send();
  });

  app.delete('/api/workspaces/:id/invitations/:invitationId', { preHandler: requireSession }, async (request, reply) => {
    const { id, invitationId } = z
      .object({ id: z.string().uuid(), invitationId: z.string().uuid() })
      .parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    await workspaces.revokeInvitation({
      workspaceId: id,
      actor: { id: user.id, role: membership.role },
      invitationId,
    });
    return reply.status(204).send();
  });

  app.post('/api/workspaces', { preHandler: requireSession }, async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    const user = currentUser(request);
    const workspace = await workspaces.create(user.id, name);
    return reply.status(201).send({
      workspace: { id: workspace.id, name: workspace.name, role: workspace.role },
    });
  });

  app.get('/api/workspaces', { preHandler: requireSession }, async (request) => {
    const user = currentUser(request);
    const rows = await workspaces.listForUser(user.id);
    return { workspaces: rows.map((w) => ({ id: w.id, name: w.name, role: w.role })) };
  });

  app.get('/api/workspaces/:id/members', { preHandler: requireSession }, async (request) => {
    const { id } = workspaceParams.parse(request.params);
    const user = currentUser(request);
    // Non-members get 404 here, identical to a workspace that does not exist.
    const membership = await workspaces.requireMember(id, user.id);

    const members = await workspaces.listMembers(id);
    // Pending invitations are visible to the owner only — they contain email addresses
    // of people who have not joined.
    const invitations =
      membership.role === 'OWNER' ? await workspaces.listPendingInvitations(id) : [];

    return {
      role: membership.role,
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        role: m.role,
        joinedAt: m.created_at,
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expires_at,
      })),
    };
  });

  app.post('/api/workspaces/:id/invitations', {
    preHandler: requireSession,
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const { id } = workspaceParams.parse(request.params);
      const user = currentUser(request);

      // Authorize before validating the body. A non-member must get the same 404 whether
      // or not their request was well-formed, so that a malformed request can never be
      // used to distinguish "workspace exists" from "workspace does not exist".
      const membership = await workspaces.requireMember(id, user.id);
      requireOwner(membership.role);

      const body = z
        .object({ email: z.string().email().max(255), role: z.enum(['OWNER', 'MEMBER', 'VIEWER']).default('MEMBER') })
        .parse(request.body);

      const result = await workspaces.invite({
        workspaceId: id,
        actor: { id: user.id, role: membership.role },
        email: body.email,
        role: body.role,
      });

      // No email provider is integrated (a deliberate scope decision), so in development
      // the link is surfaced in the response and in the logs instead.
      request.log.info(
        { workspaceId: id, email: body.email, inviteUrl: result.alwaysUrl },
        'invitation created (no mail provider configured)',
      );

      return reply.status(201).send({
        invitation: {
          id: result.invitation.id,
          email: result.invitation.email,
          role: result.invitation.role,
          expiresAt: result.invitation.expires_at,
        },
        inviteUrl: result.url,
      });
    },
  });
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: { workspaces: WorkspacesService },
): void {
  const { workspaces } = deps;
  const tokenParams = z.object({ token: z.string().min(10).max(200) });

  // Public: renders the invite landing page before the recipient has signed in.
  app.get('/api/invitations/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { token } = tokenParams.parse(request.params);
      return workspaces.previewInvitation(token);
    },
  });

  app.post('/api/invitations/:token/accept', {
    preHandler: requireSession,
    handler: async (request) => {
      const { token } = tokenParams.parse(request.params);
      const user = currentUser(request);
      return workspaces.acceptInvitation(token, user);
    },
  });
}
