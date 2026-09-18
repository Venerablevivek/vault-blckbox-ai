import type { Pool } from 'pg';
import type { Db } from './pool';
import { withTransaction } from './tx';

/**
 * Runs `fn` in a transaction where the database's row-level security policies only show rows from
 * workspaces `userId` belongs to (see migrations/024_row_level_security.sql). Used for multi-row
 * reads, as defence in depth behind the explicit workspace filter every query already has.
 *
 * set_config(..., true) is transaction-local, so the setting can never leak to the next request
 * that borrows the same pooled connection, and it works through PgBouncer's transaction pooling.
 */
export async function withTenant<T>(pool: Pool, userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await tx.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    return fn(tx);
  });
}
