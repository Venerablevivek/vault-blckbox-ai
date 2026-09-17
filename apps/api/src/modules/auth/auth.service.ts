import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../../db/pool';
import { withTransaction } from '../../db/tx';
import { AppError, Errors } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/tokens';
import { stripControlCharacters } from '../../lib/text';
import type { Clock, SessionUser } from '../../types';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import { invitationsRepo } from '../workspaces/invitations.repo';
import type { AuditService } from '../audit/audit.service';
import type { JobQueue } from '../../jobs/queue';
import { passwordChangedEmail, passwordResetEmail } from '../../mail/templates';
import { authRepo } from './auth.repo';
import { burnVerifyTime, hashPassword, verifyPassword } from './password';

export interface AuthServiceOptions {
  pool: Pool;
  clock: Clock;
  sessionTtlDays: number;
  audit: AuditService;
  lockoutAttempts: number;
  lockoutMinutes: number;
  jobs: JobQueue;
  logger: Logger;
  webUrl: string;
  passwordResetTtlMinutes: number;
}

/** A session's last_seen_at is refreshed at most this often, so reads don't each cost a write. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

/** Reset emails per account per hour. Beyond this, requests succeed silently and send nothing. */
export const PASSWORD_RESETS_PER_HOUR = 3;

function cleanUserAgent(userAgent: string | undefined | null): string | null {
  const value = (userAgent ? stripControlCharacters(userAgent) : undefined)?.trim();
  return value ? value.slice(0, 300) : null;
}

/** Emails are lowercased at the boundary so `Foo@x.com` and `foo@x.com` are one account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Failed logins are keyed by a hash of the submitted address, not a user id, so the same
 * lockout applies whether or not an account exists. A locked response therefore cannot be
 * used to discover which addresses are registered.
 */
function loginKey(email: string): Buffer {
  return createHash('sha256').update(`login:${email}`, 'utf8').digest();
}

export function createAuthService({
  pool,
  clock,
  sessionTtlDays,
  audit,
  lockoutAttempts,
  lockoutMinutes,
  jobs,
  logger,
  webUrl,
  passwordResetTtlMinutes,
}: AuthServiceOptions) {
  async function issueSession(
    db: Db,
    userId: string,
    userAgent?: string | null,
  ): Promise<{ id: string; token: string; expiresAt: Date }> {
    const id = randomUUID();
    const token = generateToken('ses');
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + sessionTtlDays * 86_400_000);
    await authRepo.insertSession(db, {
      id,
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: cleanUserAgent(userAgent),
      now,
    });
    return { id, token, expiresAt };
  }

  /**
   * Refuses the attempt while the address is locked. Shared by sign-in and password change,
   * so a stolen session can't be used to guess the account's password either.
   */
  async function assertNotLocked(email: string): Promise<void> {
    const windowMs = lockoutMinutes * 60_000;
    const recent = await authRepo.recentLoginFailures(
      pool,
      loginKey(email),
      new Date(clock.now().getTime() - windowMs),
    );
    if (recent.count >= lockoutAttempts && recent.oldest) {
      const unlockAt = recent.oldest.getTime() + windowMs;
      throw Errors.tooManyRequests(
        'ACCOUNT_LOCKED',
        'Too many failed sign-in attempts for this account. Try again later.',
        (unlockAt - clock.now().getTime()) / 1000,
      );
    }
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
    async register(input: { email: string; password: string; inviteToken?: string; userAgent?: string }) {
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

        const session = await issueSession(tx, user.id, input.userAgent);
        return { user: { id: user.id, email: user.email }, session };
      });
    },

    /**
     * Logs in, with per-account throttling on top of the per-IP rate limit.
     *
     * Per-IP limits don't slow down guessing one account's password from many addresses.
     * After LOGIN_LOCKOUT_ATTEMPTS failures for an address inside the window, every attempt for
     * that address is refused, even with the right password, until the window passes. A
     * successful login clears the count.
     */
    async login(input: { email: string; password: string; userAgent?: string }) {
      const email = normalizeEmail(input.email);
      const key = loginKey(email);
      await assertNotLocked(email);

      const user = await authRepo.findUserByEmail(pool, email);
      if (!user) {
        // Burn comparable CPU time so response latency does not reveal which addresses exist.
        await burnVerifyTime(input.password);
        await authRepo.recordLoginFailure(pool, key, clock.now());
        throw Errors.invalidCredentials();
      }

      const ok = await verifyPassword(user.password_hash, input.password);
      if (!ok) {
        await authRepo.recordLoginFailure(pool, key, clock.now());
        throw Errors.invalidCredentials();
      }

      await authRepo.clearLoginFailures(pool, key);

      // A fresh session row on every login; no client-supplied identifier is ever honoured.
      const session = await issueSession(pool, user.id, input.userAgent);
      return { user: { id: user.id, email: user.email }, session };
    },

    async logout(token: string): Promise<void> {
      await authRepo.deleteSession(pool, hashToken(token));
    },

    async resolveSession(token: string): Promise<{ user: SessionUser; sessionId: string } | null> {
      const now = clock.now();
      const row = await authRepo.findValidSession(pool, hashToken(token), now);
      if (!row) return null;
      if (!row.last_seen_at || now.getTime() - row.last_seen_at.getTime() > SESSION_TOUCH_INTERVAL_MS) {
        // Best effort: "last active" is a convenience, never a reason to fail a request.
        authRepo.touchSession(pool, row.session_id, now).catch((error: unknown) => {
          logger.warn({ err: error }, 'failed to update session last_seen_at');
        });
      }
      return { user: { id: row.id, email: row.email }, sessionId: row.session_id };
    },

    /**
     * Starts a password reset. The caller always gets the same answer whether or not the
     * address has an account; the route does not wait for this to finish, so response time
     * doesn't reveal it either.
     */
    async requestPasswordReset(rawEmail: string): Promise<void> {
      const email = normalizeEmail(rawEmail);
      const user = await authRepo.findUserByEmail(pool, email);
      if (!user) return;

      const now = clock.now();
      const recent = await authRepo.countRecentPasswordResets(pool, user.id, new Date(now.getTime() - 3_600_000));
      if (recent >= PASSWORD_RESETS_PER_HOUR) {
        logger.warn({ userId: user.id }, 'password reset requested too often; no email sent');
        return;
      }

      const token = generateToken('pwr');
      // The token and its email commit together. The email is a durable job, retried with backoff
      // if the mail server is down, and there is never an email for a token that wasn't stored.
      await withTransaction(pool, async (tx) => {
        await authRepo.insertPasswordReset(tx, {
          id: randomUUID(),
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + passwordResetTtlMinutes * 60_000),
          now,
        });
        // The token travels in the URL fragment, which browsers never send to a server: it stays
        // out of access logs, proxies and Referer headers.
        await jobs.enqueue(
          tx,
          'email.send',
          passwordResetEmail({
            to: user.email,
            url: `${webUrl}/reset-password#token=${token}`,
            ttlMinutes: passwordResetTtlMinutes,
          }),
        );
      });
    },

    /**
     * Completes a reset: claims the single-use token, sets the password, invalidates every other
     * reset link, ends every existing session and signs this browser in. All in one transaction.
     */
    async resetPassword(input: { token: string; password: string; userAgent?: string }) {
      const passwordHash = await hashPassword(input.password);
      const now = clock.now();

      const result = await withTransaction(pool, async (tx) => {
        const reset = await authRepo.claimPasswordReset(tx, hashToken(input.token), now);
        if (!reset) {
          throw new AppError(
            410,
            'RESET_LINK_INVALID',
            'This reset link is invalid, already used or expired. Request a new one.',
          );
        }
        const user = await authRepo.findUserById(tx, reset.user_id);
        if (!user)
          throw new AppError(
            410,
            'RESET_LINK_INVALID',
            'This reset link is invalid, already used or expired. Request a new one.',
          );

        await authRepo.updatePassword(tx, user.id, passwordHash, now);
        await authRepo.invalidatePasswordResets(tx, user.id, now);
        const signedOut = await authRepo.deleteOtherSessions(tx, user.id, null);
        // Whoever was guessing this password no longer matters: it has changed.
        await authRepo.clearLoginFailures(tx, loginKey(user.email));
        const session = await issueSession(tx, user.id, input.userAgent);
        await jobs.enqueue(tx, 'email.send', passwordChangedEmail({ to: user.email, webUrl, via: 'reset' }));
        return { user: { id: user.id, email: user.email }, session, signedOut };
      });
      return result;
    },

    /**
     * Changes the password of a signed-in user. The current password is required, and wrong
     * guesses count toward the same lockout as sign-in. Every other session is ended; this one
     * stays signed in.
     */
    async changePassword(input: {
      user: SessionUser;
      sessionId: string;
      currentPassword: string;
      newPassword: string;
    }): Promise<{ signedOutSessions: number }> {
      const email = normalizeEmail(input.user.email);
      await assertNotLocked(email);

      const user = await authRepo.findUserById(pool, input.user.id);
      if (!user) throw Errors.unauthorized();

      if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
        await authRepo.recordLoginFailure(pool, loginKey(email), clock.now());
        throw Errors.badRequest('INCORRECT_PASSWORD', 'Your current password is incorrect.');
      }
      if (input.currentPassword === input.newPassword) {
        throw Errors.badRequest('PASSWORD_UNCHANGED', 'Choose a password different from your current one.');
      }

      const passwordHash = await hashPassword(input.newPassword);
      const now = clock.now();
      const signedOutSessions = await withTransaction(pool, async (tx) => {
        await authRepo.updatePassword(tx, user.id, passwordHash, now);
        await authRepo.invalidatePasswordResets(tx, user.id, now);
        await authRepo.clearLoginFailures(tx, loginKey(email));
        await jobs.enqueue(tx, 'email.send', passwordChangedEmail({ to: user.email, webUrl, via: 'settings' }));
        return authRepo.deleteOtherSessions(tx, user.id, input.sessionId);
      });
      return { signedOutSessions };
    },

    async listSessions(userId: string, currentSessionId: string) {
      const rows = await authRepo.listSessions(pool, userId, clock.now());
      return rows.map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at ?? row.created_at,
        expiresAt: row.expires_at,
        current: row.id === currentSessionId,
      }));
    },

    /** Signs out one of the caller's sessions. 404 for an id that isn't theirs. */
    async revokeSession(userId: string, sessionId: string, currentSessionId: string): Promise<{ current: boolean }> {
      const deleted = await authRepo.deleteSessionById(pool, userId, sessionId);
      if (!deleted) throw Errors.notFound('Session');
      return { current: sessionId === currentSessionId };
    },

    async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
      return authRepo.deleteOtherSessions(pool, userId, currentSessionId);
    },

    async listWorkspaces(userId: string) {
      return workspacesRepo.listForUser(pool, userId);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
