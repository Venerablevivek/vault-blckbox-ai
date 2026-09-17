import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/tokens';
import { requireOwner } from '../../policy';
import type { Clock, Membership, Role } from '../../types';
import { normalizeEmail } from '../auth/auth.service';
import { authRepo } from '../auth/auth.repo';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { sharesRepo } from '../shares/shares.repo';
import { invitationsRepo } from './invitations.repo';
import { workspacesRepo } from './workspaces.repo';

export interface WorkspacesServiceOptions {
  pool: Pool;
  clock: Clock;
  inviteTtlHours: number;
  webUrl: string;
  exposeInviteLinks: boolean;
  audit: AuditService;
  notifications: NotificationsService;
}

export function createWorkspacesService(opts: WorkspacesServiceOptions) {
  const { pool, clock, audit, notifications } = opts;

  return {
    /**
     * Resolves the caller's membership of a workspace.
     *
     * Returns 404 (not 403) for a non-member, deliberately: a 403 would confirm that the
     * workspace exists, which is an enumeration oracle. A non-member gets the same answer
     * as for an id that never existed.
     */
    async requireMember(workspaceId: string, userId: string): Promise<Membership> {
      const role = await workspacesRepo.findMembership(pool, workspaceId, userId);
      if (!role) throw Errors.notFound('Workspace');
      return { workspaceId, role };
    },

    async create(userId: string, name: string) {
      return withTransaction(pool, async (tx) => {
        const workspace = await workspacesRepo.insertWorkspace(tx, {
          id: randomUUID(),
          name,
          createdBy: userId,
        });
        await workspacesRepo.insertMember(tx, {
          workspaceId: workspace.id,
          userId,
          role: 'OWNER',
        });
        // Written inside the transaction: the workspace and the record of its creation
        // land together or not at all.
        await audit.record(
          {
            workspaceId: workspace.id,
            actorUserId: userId,
            action: 'workspace.created',
            resourceType: 'workspace',
            resourceId: workspace.id,
            metadata: { name },
          },
          tx,
        );
        return { ...workspace, role: 'OWNER' as Role };
      });
    },

    async listForUser(userId: string) {
      return workspacesRepo.listForUser(pool, userId);
    },

    async listMembers(workspaceId: string) {
      return workspacesRepo.listMembers(pool, workspaceId);
    },

    async listPendingInvitations(workspaceId: string) {
      return invitationsRepo.listPending(pool, workspaceId);
    },

    /**
     * Creates an invitation bound to an email address.
     *
     * There is no email provider in this project: per the blueprint, the generated link is
     * returned in the response (and logged) in development instead.
     */
    async invite(input: {
      workspaceId: string;
      actor: { id: string; role: Role };
      email: string;
      role: Role;
    }) {
      requireOwner(input.actor.role);

      const email = normalizeEmail(input.email);
      if (!['OWNER', 'MEMBER', 'VIEWER'].includes(input.role)) {
        throw Errors.badRequest('INVALID_ROLE', 'Role must be OWNER, MEMBER or VIEWER.');
      }

      // If the address already belongs to a member, say so plainly rather than creating a
      // dangling invitation. This does not leak whether the address has an account at all,
      // only whether it is already in *this* workspace, which the caller can see anyway.
      const existingUser = await authRepo.findUserByEmail(pool, email);
      if (existingUser) {
        const role = await workspacesRepo.findMembership(pool, input.workspaceId, existingUser.id);
        if (role) {
          throw Errors.conflict('ALREADY_MEMBER', 'That person is already in this workspace.');
        }
      }

      const token = generateToken('inv');
      const expiresAt = new Date(clock.now().getTime() + opts.inviteTtlHours * 3_600_000);

      const invitation = await invitationsRepo.upsertPending(pool, {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        email,
        tokenHash: hashToken(token),
        role: input.role,
        expiresAt,
        createdBy: input.actor.id,
      });

      await audit.record({
        workspaceId: input.workspaceId,
        actorUserId: input.actor.id,
        action: 'member.invited',
        resourceType: 'invitation',
        resourceId: invitation.id,
        metadata: { email, role: input.role },
      });

      const url = `${opts.webUrl}/invite/${token}`;
      return {
        invitation,
        // The plaintext token exists only here; the database holds a hash of it.
        url: opts.exposeInviteLinks ? url : undefined,
        alwaysUrl: url,
      };
    },

    /**
     * Changes a member's role.
     *
     * The invariant is "a workspace always has at least one owner". It is checked under a
     * row lock on the workspace so two concurrent demotions cannot both pass.
     */
    async changeRole(input: {
      workspaceId: string;
      actor: { id: string; role: Role };
      targetUserId: string;
      role: Role;
    }) {
      requireOwner(input.actor.role);

      await withTransaction(pool, async (tx) => {
        await workspacesRepo.lockForUpdate(tx, input.workspaceId);

        const current = await workspacesRepo.findMembership(tx, input.workspaceId, input.targetUserId);
        if (!current) throw Errors.notFound('Member');
        if (current === input.role) return;

        if (current === 'OWNER' && (await workspacesRepo.countOwners(tx, input.workspaceId)) <= 1) {
          throw Errors.conflict(
            'LAST_OWNER',
            'A workspace needs at least one owner. Promote someone else first.',
          );
        }

        await workspacesRepo.updateRole(tx, input.workspaceId, input.targetUserId, input.role);

        // A VIEWER cannot share, so links they created while they could stop working now —
        // in the same transaction, so there is no window where the role is gone but the links live.
        const revokedLinks =
          input.role === 'VIEWER'
            ? await sharesRepo.revokeCreatedByInWorkspace(tx, input.workspaceId, input.targetUserId, clock.now())
            : 0;

        const email = await workspacesRepo.findUserEmail(tx, input.targetUserId);
        await audit.record(
          {
            workspaceId: input.workspaceId,
            actorUserId: input.actor.id,
            action: 'member.role_changed',
            resourceType: 'member',
            resourceId: input.targetUserId,
            metadata: { email, from: current, to: input.role, revokedLinks },
          },
          tx,
        );
      });

      if (input.targetUserId !== input.actor.id) {
        const workspace = await workspacesRepo.findById(pool, input.workspaceId);
        notifications.notify({
          userId: input.targetUserId,
          workspaceId: input.workspaceId,
          type: 'member.role_changed',
          title: `You are now ${input.role === 'OWNER' ? 'an owner' : input.role === 'MEMBER' ? 'a member' : 'a viewer'} of ${workspace?.name ?? 'a workspace'}`,
          body:
            input.role === 'OWNER'
              ? 'You can now invite people, manage members and view activity.'
              : input.role === 'MEMBER'
                ? 'You can upload, download and share documents here.'
                : 'You can view and download documents. Share links you created have been revoked.',
          resourceId: input.workspaceId,
        });
      }
    },

    /**
     * Removes a member, or lets a member leave.
     *
     * Their documents stay: documents belong to the workspace, not to the person who uploaded
     * them. The share links they created are revoked in the same transaction, so someone who
     * leaves cannot keep distributing workspace documents through links they handed out.
     * Access ends on their very next request because membership is read per request.
     */
    async removeMember(input: {
      workspaceId: string;
      actor: { id: string; role: Role };
      targetUserId: string;
    }) {
      const leaving = input.targetUserId === input.actor.id;
      if (!leaving) requireOwner(input.actor.role);

      const workspaceName = await withTransaction(pool, async (tx) => {
        await workspacesRepo.lockForUpdate(tx, input.workspaceId);

        const current = await workspacesRepo.findMembership(tx, input.workspaceId, input.targetUserId);
        if (!current) throw Errors.notFound('Member');

        if (current === 'OWNER' && (await workspacesRepo.countOwners(tx, input.workspaceId)) <= 1) {
          throw Errors.conflict(
            'LAST_OWNER',
            leaving
              ? 'You are the only owner. Make someone else an owner before leaving.'
              : 'A workspace needs at least one owner.',
          );
        }

        const email = await workspacesRepo.findUserEmail(tx, input.targetUserId);
        await workspacesRepo.deleteMember(tx, input.workspaceId, input.targetUserId);
        const revokedLinks = await sharesRepo.revokeCreatedByInWorkspace(
          tx,
          input.workspaceId,
          input.targetUserId,
          clock.now(),
        );
        await audit.record(
          {
            workspaceId: input.workspaceId,
            actorUserId: input.actor.id,
            action: leaving ? 'member.left' : 'member.removed',
            resourceType: 'member',
            resourceId: input.targetUserId,
            metadata: { email, revokedLinks },
          },
          tx,
        );
        const workspace = await workspacesRepo.findById(tx, input.workspaceId);
        return workspace?.name ?? 'a workspace';
      });

      if (!leaving) {
        notifications.notify({
          userId: input.targetUserId,
          workspaceId: null, // they can no longer open the workspace, so don't link to it
          type: 'member.removed',
          title: `You were removed from ${workspaceName}`,
          body: 'You no longer have access to its documents.',
          resourceId: input.workspaceId,
        });
      }
    },

    async revokeInvitation(input: { workspaceId: string; actor: { id: string; role: Role }; invitationId: string }) {
      requireOwner(input.actor.role);
      const revoked = await invitationsRepo.deletePending(pool, input.workspaceId, input.invitationId);
      if (!revoked) throw Errors.notFound('Invitation');
      await audit.record({
        workspaceId: input.workspaceId,
        actorUserId: input.actor.id,
        action: 'invitation.revoked',
        resourceType: 'invitation',
        resourceId: input.invitationId,
        metadata: { email: revoked.email },
      });
    },

    async rename(input: { workspaceId: string; actor: { id: string; role: Role }; name: string }) {
      requireOwner(input.actor.role);
      const before = await workspacesRepo.findById(pool, input.workspaceId);
      await workspacesRepo.rename(pool, input.workspaceId, input.name);
      await audit.record({
        workspaceId: input.workspaceId,
        actorUserId: input.actor.id,
        action: 'workspace.renamed',
        resourceType: 'workspace',
        resourceId: input.workspaceId,
        metadata: { from: before?.name, to: input.name },
      });
    },

    /** Public preview shown before sign-in. Returns only what the landing page needs. */
    async previewInvitation(token: string) {
      const invite = await invitationsRepo.findByTokenHash(pool, hashToken(token));
      if (!invite) throw Errors.notFound('Invitation');
      if (invite.accepted_at) {
        throw Errors.gone('This invitation has already been used.');
      }
      if (invite.expires_at <= clock.now()) {
        throw Errors.gone('This invitation has expired.');
      }
      return {
        workspaceName: invite.workspace_name,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expires_at,
      };
    },

    /**
     * Accepts an invitation for an already-authenticated user.
     *
     * The membership insert and the invitation stamp happen in one transaction, and
     * `markAccepted` is a conditional UPDATE, so accepting twice cannot create two
     * memberships even under a race.
     */
    async acceptInvitation(token: string, user: { id: string; email: string }) {
      const invite = await invitationsRepo.findByTokenHash(pool, hashToken(token));
      if (!invite) throw Errors.notFound('Invitation');

      if (invite.email !== normalizeEmail(user.email)) {
        throw Errors.conflict(
          'INVITE_EMAIL_MISMATCH',
          `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`,
        );
      }

      return withTransaction(pool, async (tx) => {
        const accepted = await invitationsRepo.markAccepted(tx, invite.id, clock.now());
        if (!accepted) {
          throw Errors.gone('This invitation has already been used or has expired.');
        }
        await workspacesRepo.insertMember(tx, {
          workspaceId: accepted.workspace_id,
          userId: user.id,
          role: accepted.role,
        });
        await audit.record(
          {
            workspaceId: accepted.workspace_id,
            actorUserId: user.id,
            action: 'member.joined',
            resourceType: 'member',
            resourceId: user.id,
            metadata: { email: user.email },
          },
          tx,
        );

        const workspace = await workspacesRepo.findById(tx, accepted.workspace_id);

        notifications.notifyWorkspace(accepted.workspace_id, user.id, {
          type: 'member.joined',
          title: `${user.email} joined ${workspace?.name ?? 'the workspace'}`,
          body: 'They can now upload, download and share documents here.',
          resourceId: user.id,
        });

        return { workspaceId: accepted.workspace_id, workspaceName: workspace?.name ?? '' };
      });
    },
  };
}

export type WorkspacesService = ReturnType<typeof createWorkspacesService>;
