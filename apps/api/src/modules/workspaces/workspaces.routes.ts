import type { FastifyInstance } from 'fastify';
import {
  ChangeRoleBody,
  CreateWorkspaceBody,
  DeleteWorkspaceBody,
  InvitationParams,
  InviteBody,
  InviteTokenParams,
  MemberParams,
  OverviewQuery,
  RenameWorkspaceBody,
  WorkspaceParams,
} from '../../contracts/workspaces';
import { currentUser, requireSession } from '../../plugins/session';
import { requireOwner } from '../../policy';
import type { OverviewService } from '../overview/overview.service';
import type { WorkspacesService } from './workspaces.service';


export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { workspaces: WorkspacesService; overview: OverviewService },
): void {
  const { workspaces, overview } = deps;

  // Dashboard data. Any member; the activity slice inside is owner-only.
  app.get('/api/workspaces/:id/overview', { preHandler: requireSession }, async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    const { tz } = OverviewQuery.parse(request.query);
    return { role: membership.role, ...(await overview.forWorkspace(id, membership.role, tz)) };
  });

  app.patch('/api/workspaces/:id', { preHandler: requireSession }, async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    requireOwner(membership.role);
    const { name } = RenameWorkspaceBody.parse(request.body);
    await workspaces.rename({ workspaceId: id, actor: { id: user.id, role: membership.role }, name });
    return { workspace: { id, name } };
  });

  // Storage used (including the trash) and the workspace's quota.
  app.get('/api/workspaces/:id/storage', { preHandler: requireSession }, async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    await workspaces.requireMember(id, currentUser(request).id);
    return { storage: await workspaces.storageUsage(id) };
  });

  // Deletes the workspace. Body: { confirmName } — the workspace's exact current name.
  app.delete('/api/workspaces/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(id, user.id);
    requireOwner(membership.role);
    const { confirmName } = DeleteWorkspaceBody.parse(request.body);
    await workspaces.deleteWorkspace({
      workspaceId: id,
      actor: { id: user.id, role: membership.role, email: user.email },
      confirmName,
    });
    return reply.status(204).send();
  });

  app.patch('/api/workspaces/:id/members/:userId', { preHandler: requireSession }, async (request, reply) => {
    const { id, userId } = MemberParams.parse(request.params);
    const user = currentUser(request);
    // Authorize before reading the body, so a non-member always sees the same 404.
    const membership = await workspaces.requireMember(id, user.id);
    requireOwner(membership.role);
    const { role } = ChangeRoleBody.parse(request.body);
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
    const { id, userId } = MemberParams.parse(request.params);
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
    const { id, invitationId } = InvitationParams.parse(request.params);
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
    const { name } = CreateWorkspaceBody.parse(request.body);
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
    const { id } = WorkspaceParams.parse(request.params);
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
      const { id } = WorkspaceParams.parse(request.params);
      const user = currentUser(request);

      // Authorize before validating the body. A non-member must get the same 404 whether
      // or not their request was well-formed, so that a malformed request can never be
      // used to distinguish "workspace exists" from "workspace does not exist".
      const membership = await workspaces.requireMember(id, user.id);
      requireOwner(membership.role);

      const body = InviteBody.parse(request.body);

      const result = await workspaces.invite({
        workspaceId: id,
        actor: { id: user.id, role: membership.role },
        email: body.email,
        role: body.role,
      });

      // The link carries a bearer token, so it is never logged. It is emailed, and returned
      // here only when EXPOSE_INVITE_LINKS is on (development), so the owner can copy it.
      request.log.info({ workspaceId: id, invitationId: result.invitation.id, emailSent: result.emailSent }, 'invitation created');

      return reply.status(201).send({
        invitation: {
          id: result.invitation.id,
          email: result.invitation.email,
          role: result.invitation.role,
          expiresAt: result.invitation.expires_at,
        },
        inviteUrl: result.url,
        emailSent: result.emailSent,
      });
    },
  });
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: { workspaces: WorkspacesService },
): void {
  const { workspaces } = deps;

  // Public: renders the invite landing page before the recipient has signed in.
  app.get('/api/invitations/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { token } = InviteTokenParams.parse(request.params);
      return workspaces.previewInvitation(token);
    },
  });

  app.post('/api/invitations/:token/accept', {
    preHandler: requireSession,
    handler: async (request) => {
      const { token } = InviteTokenParams.parse(request.params);
      const user = currentUser(request);
      return workspaces.acceptInvitation(token, user);
    },
  });
}
