import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Db } from '../../db/pool';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/tokens';
import type { Clock, SessionUser } from '../../types';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import { invitationsRepo } from '../workspaces/invitations.repo';
import type { AuditService } from '../audit/audit.service';
import { authRepo } from './auth.repo';
import { burnVerifyTime, hashPassword, verifyPassword } from './password';

export interface AuthServiceOptions {
  pool: Pool;
  clock: Clock;
  sessionTtlDays: number;
  audit: AuditService;
}

/** Emails are lowercased at the boundary so `Foo@x.com` and `foo@x.com` are one account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createAuthService({ pool, clock, sessionTtlDays, audit }: AuthServiceOptions) {
  async function issueSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = generateToken('ses');
    const expiresAt = new Date(clock.now().getTime() + sessionTtlDays * 86_400_000);
    await authRepo.insertSession(db, {
      id: randomUUID(),
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  return {
    /**
     * Creates the user, their first workspace and the OWNER membership in ONE transaction.
     *
     * Every document belongs to a workspace (documents.workspace_id is NOT NULL), so a
     * user without one would have nowhere to upload. Creating it here means there is
     * exactly one ownership model and therefore exactly one authorization path.
     *
     * When an invite token is supplied, it is consumed in the same transaction — so a
     * user can never end up created but not joined.
     */
    async register(input: { email: string; password: string; inviteToken?: string }) {
      const email = normalizeEmail(input.email);

      const existing = await authRepo.findUserByEmail(pool, email);
      if (existing) {
        throw Errors.conflict('EMAIL_TAKEN', 'An account with that email already exists.');
      }

      const passwordHash = await hashPassword(input.password);
      const now = clock.now();

      return withTransaction(pool, async (tx) => {
        const user = await authRepo.insertUser(tx, { id: randomUUID(), email, passwordHash });

        const workspace = await workspacesRepo.insertWorkspace(tx, {
          id: randomUUID(),
          name: 'My Workspace',
          createdBy: user.id,
        });
        await workspacesRepo.insertMember(tx, {
          workspaceId: workspace.id,
          userId: user.id,
          role: 'OWNER',
        });

        // The workspace created here is created by the same rule as any other, so it is
        // audited the same way. Otherwise every user's first workspace would have a blank
        // history, which is exactly the kind of gap an audit trail must not have.
        await audit.record(
          {
            workspaceId: workspace.id,
            actorUserId: user.id,
            action: 'workspace.created',
            resourceType: 'workspace',
            resourceId: workspace.id,
            metadata: { name: workspace.name, viaRegistration: true },
          },
          tx,
        );

        if (input.inviteToken) {
          const invite = await invitationsRepo.findByTokenHash(tx, hashToken(input.inviteToken));
          // An invitation is bound to an email address. Without this check, forwarding the
          // link to anyone would be a privilege escalation into the workspace.
          if (invite && invite.email === email) {
            const accepted = await invitationsRepo.markAccepted(tx, invite.id, now);
            if (accepted) {
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
                  metadata: { email, viaRegistration: true },
                },
                tx,
              );
            }
          }
        }

        const session = await issueSession(tx, user.id);
        return { user: { id: user.id, email: user.email } as SessionUser, session };
      });
    },

    async login(input: { email: string; password: string }) {
      const email = normalizeEmail(input.email);
      const user = await authRepo.findUserByEmail(pool, email);

      if (!user) {
        // Burn comparable CPU time so response latency does not reveal which addresses
        // have accounts.
        await burnVerifyTime(input.password);
        throw Errors.invalidCredentials();
      }

      const ok = await verifyPassword(user.password_hash, input.password);
      if (!ok) throw Errors.invalidCredentials();

      // A fresh session row on every login; no client-supplied identifier is ever honoured.
      const session = await issueSession(pool, user.id);
      return { user: { id: user.id, email: user.email } as SessionUser, session };
    },

    async logout(token: string): Promise<void> {
      await authRepo.deleteSession(pool, hashToken(token));
    },

    async resolveSession(token: string): Promise<SessionUser | null> {
      return authRepo.findValidSession(pool, hashToken(token), clock.now());
    },

    async listWorkspaces(userId: string) {
      return workspacesRepo.listForUser(pool, userId);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
