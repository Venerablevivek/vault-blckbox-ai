import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

/**
 * Ordered-SQL migration runner.
 *
 * The blueprint allows node-pg-migrate or a simple ordered runner. This is the simple
 * runner: numbered .sql files applied in filename order, recorded in a ledger table.
 * Choosing raw SQL for the app and then hiding the schema behind a migration DSL would
 * defeat the point — here the DDL is readable directly in migrations/.
 *
 * Forward-only; there are no down migrations. A project of this size re-creates rather
 * than rolls back.
 *
 * A Postgres advisory lock makes concurrent starts safe: if two API containers boot at
 * once, one waits rather than both trying to apply the same file.
 */
const ADVISORY_LOCK_KEY = 8_273_461_209;

export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
  logger: Logger,
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const done = new Set(rows.map((r) => r.version));

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      logger.info({ migration: file }, 'applying migration');

      // Each migration is its own transaction: a failure leaves the database at the
      // last good version rather than half-migrated.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }

    if (applied.length === 0) logger.info('database schema is up to date');
    else logger.info({ count: applied.length }, 'migrations applied');

    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
