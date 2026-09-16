import type { Pool } from 'pg';
import type { Db } from './pool';

/**
 * Runs `fn` inside a single transaction, rolling back on any thrown error.
 *
 * Used wherever related rows must change together:
 *   - register: user + workspace + owner membership
 *   - accept invitation: membership insert + invitation stamped accepted
 *   - create workspace: workspace + owner membership
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
