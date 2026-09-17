import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { Config } from '../config';

/**
 * Thin wrapper over `pg`. Every query in the application goes through this type, and
 * `Db` is also what a transaction hands to repositories — so repository functions work
 * identically inside and outside a transaction.
 */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface PoolOptions {
  max?: number;
  /** Server-side limit per statement; 0 or undefined for none. */
  statementTimeoutMs?: number;
  applicationName?: string;
}

export function createPool(connectionString: string, options: PoolOptions = {}): Pool {
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? 'vault',
    ...(options.statementTimeoutMs
      ? {
          // A runaway query fails instead of holding a connection indefinitely, and a transaction
          // left open by a bug can't hold locks for long.
          statement_timeout: options.statementTimeoutMs,
          idle_in_transaction_session_timeout: options.statementTimeoutMs * 2,
        }
      : {}),
  });
}

/**
 * The three ways the application reaches PostgreSQL.
 *
 * - `pool`: every request's queries and transactions. May point at PgBouncer in transaction
 *   pooling mode (DATABASE_URL).
 * - `directPool`: work that needs a real session, which transaction pooling does not provide:
 *   LISTEN (job wake-ups, live notifications), session advisory locks (migrations, maintenance)
 *   and long-running maintenance. DATABASE_DIRECT_URL, defaulting to DATABASE_URL. No statement
 *   timeout, because migrations and maintenance can legitimately run longer.
 * - `readPool`: reads that tolerate replication lag (the dashboard, the audit trail).
 *   DATABASE_READ_URL, defaulting to the main pool.
 */
export interface Database {
  pool: Pool;
  directPool: Pool;
  readPool: Pool;
  end(): Promise<void>;
}

export function createDatabase(config: Config, applicationName: string): Database {
  const pool = createPool(config.DATABASE_URL, {
    max: config.DB_POOL_MAX,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    applicationName,
  });
  const directPool = config.DATABASE_DIRECT_URL
    ? createPool(config.DATABASE_DIRECT_URL, { max: 5, applicationName: `${applicationName}-direct` })
    : pool;
  const readPool = config.DATABASE_READ_URL
    ? createPool(config.DATABASE_READ_URL, {
        max: config.DB_POOL_MAX,
        statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
        applicationName: `${applicationName}-read`,
      })
    : pool;
  return {
    pool,
    directPool,
    readPool,
    async end() {
      await Promise.all([...new Set([pool, directPool, readPool])].map((p) => p.end()));
    },
  };
}

export type { PoolClient };
