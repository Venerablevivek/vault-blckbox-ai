import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Thin wrapper over `pg`. Every query in the application goes through this type, and
 * `Db` is also what a transaction hands to repositories — so repository functions work
 * identically inside and outside a transaction.
 */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export type { PoolClient };
