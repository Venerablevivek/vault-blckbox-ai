import { createHash } from 'node:crypto';
import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { Pool } from 'pg';

type IncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

/**
 * A @fastify/rate-limit store backed by PostgreSQL, so every API instance shares one set of
 * counters. The plugin constructs stores itself (`new Store(options)`), so the pool is captured in
 * the class this factory returns.
 *
 * Each request is one statement: insert the counter, or increment it, or start a new window if
 * the old one ended. Window boundaries use the database clock, so instances with drifting clocks
 * still agree.
 */
export function createPgRateLimitStore(pool: Pool, pepper: string): FastifyRateLimitStoreCtor {
  class PgRateLimitStore implements FastifyRateLimitStore {
    constructor(
      _globalOptions?: unknown,
      private readonly prefix = 'global:',
    ) {}

    /** The plugin calls incr(key, callback, timeWindow, max); its type declarations omit the last two. */
    incr(key: string, callback: IncrCallback, timeWindow = 60_000): void {
      const hashed = createHash('sha256').update(`${pepper}:${this.prefix}${key}`).digest();
      pool
        .query<{ count: number; ttl: string }>(
          `INSERT INTO rate_limits (key, count, window_ends_at)
           VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN rate_limits.window_ends_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
             window_ends_at = CASE WHEN rate_limits.window_ends_at <= now()
                                   THEN now() + ($2 || ' milliseconds')::interval
                                   ELSE rate_limits.window_ends_at END
           RETURNING count, GREATEST(0, EXTRACT(EPOCH FROM (window_ends_at - now())) * 1000)::bigint AS ttl`,
          [hashed, String(timeWindow)],
        )
        .then(({ rows }) => callback(null, { current: rows[0]!.count, ttl: Number(rows[0]!.ttl) }))
        .catch((error: Error) => callback(error));
    }

    /** A store per route, so each route's limit is counted separately. */
    child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
      const info = (routeOptions as { routeInfo?: { method?: string | string[]; url?: string } }).routeInfo;
      const method = ([] as string[]).concat(info?.method ?? '').join(',');
      return new PgRateLimitStore(undefined, `${method}${info?.url ?? ''}:`);
    }
  }
  return PgRateLimitStore;
}
