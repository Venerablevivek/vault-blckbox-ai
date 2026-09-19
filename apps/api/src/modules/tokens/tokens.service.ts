import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/tx';
import type { JobQueue } from '../../jobs/queue';
import { Errors } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/tokens';
import { apiTokenCreatedEmail } from '../../mail/templates';
import type { Clock, SessionUser } from '../../types';
import { tokensRepo, type TokenScope } from './tokens.repo';

/** Live tokens one person may hold. */
export const MAX_TOKENS_PER_USER = 25;
/** "Last used" is written at most this often per token. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface ResolvedToken {
  user: SessionUser;
  tokenId: string;
  scopes: TokenScope[];
}

export function createTokensService(deps: {
  pool: Pool;
  clock: Clock;
  logger: Logger;
  jobs: JobQueue;
  webUrl: string;
}) {
  const { pool, clock, logger, jobs } = deps;

  return {
    /**
     * Creates a token for its owner's own use. The secret is returned only here, and the owner is
     * emailed, so a token made by someone else with access to the session doesn't go unnoticed.
     */
    async create(user: SessionUser, input: { name: string; scopes: TokenScope[]; expiresInDays?: number | null }) {
      const now = clock.now();
      const secret = generateToken('vlt');
      const scopes: TokenScope[] = input.scopes.includes('write') ? ['read', 'write'] : ['read'];
      const row = await withTransaction(pool, async (tx) => {
        if ((await tokensRepo.countLive(tx, user.id, now)) >= MAX_TOKENS_PER_USER) {
          throw Errors.conflict(
            'TOO_MANY_TOKENS',
            `You can have up to ${MAX_TOKENS_PER_USER} tokens. Revoke one first.`,
          );
        }
        const created = await tokensRepo.insert(tx, {
          id: randomUUID(),
          userId: user.id,
          name: input.name.trim(),
          tokenHash: hashToken(secret),
          tokenPrefix: secret.slice(0, 12),
          scopes,
          expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000) : null,
          now,
        });
        await jobs.enqueue(
          tx,
          'email.send',
          apiTokenCreatedEmail({ to: user.email, name: created.name, scopes, webUrl: deps.webUrl }),
        );
        return created;
      });
      return { token: row, secret };
    },

    list(userId: string) {
      return tokensRepo.listForUser(pool, userId, clock.now());
    },

    async revoke(userId: string, tokenId: string): Promise<void> {
      if (!(await tokensRepo.revoke(pool, userId, tokenId, clock.now()))) throw Errors.notFound('Token');
    },

    /** The person a bearer token acts for, or null for anything unknown, revoked or expired. */
    async resolve(secret: string): Promise<ResolvedToken | null> {
      const now = clock.now();
      const row = await tokensRepo.resolve(pool, hashToken(secret), now);
      if (!row) return null;
      if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > TOUCH_INTERVAL_MS) {
        tokensRepo.touch(pool, row.id, now).catch((error: unknown) => {
          logger.warn({ err: error }, 'failed to update token last_used_at');
        });
      }
      return {
        user: { id: row.user_id, email: row.email, emailVerified: row.email_verified_at !== null },
        tokenId: row.id,
        scopes: row.scopes,
      };
    },
  };
}

export type TokensService = ReturnType<typeof createTokensService>;
