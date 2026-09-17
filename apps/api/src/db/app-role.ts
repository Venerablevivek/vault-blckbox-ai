import type { PoolClient } from 'pg';

/** The role the API and worker connect as. Fixed, because migrations and policies name it. */
export const APP_ROLE = 'vault_app';

/**
 * Creates (or updates) the least-privilege role the application runs as, and grants it exactly
 * what the application needs. Runs as the database owner, after migrations, every time: it is
 * idempotent, and re-granting covers tables created by migrations since the last run.
 *
 * The role can read and write rows, and nothing else: it cannot create or drop tables, cannot
 * TRUNCATE, is not a superuser and does not bypass row-level security. Superusers and table owners
 * skip RLS and all privilege checks, which is why the application must not connect as either.
 */
export async function ensureAppRole(client: PoolClient, password: string): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN;
      END IF;
    END
    $$`);
  // ALTER ROLE can't take a bind parameter; format(%L) quotes the password as a literal.
  const { rows } = await client.query<{ sql: string }>(
    `SELECT format('ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text) AS sql`,
    [password],
  );
  await client.query(rows[0]!.sql);
  await applyAppRolePrivileges(client);
}

export async function applyAppRolePrivileges(client: PoolClient): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${APP_ROLE}', current_database());
    END
    $$;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    REVOKE CREATE ON SCHEMA public FROM ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
    -- The migration ledger is the owner's business.
    REVOKE ALL ON schema_migrations FROM ${APP_ROLE};
  `);
  // Table-specific restrictions (for example, an append-only audit trail) are applied by
  // migrations after this blanket grant, in lockdownAppRole below.
  await lockdownAppRole(client);
}

/**
 * Privileges taken away again after the blanket grant. Kept here, next to the grant, so a re-grant
 * can never quietly restore them.
 */
async function lockdownAppRole(client: PoolClient): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF to_regclass('public.audit_events') IS NOT NULL THEN
        -- Append-only: the application can add to the audit trail and read it, never change it.
        REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM ${APP_ROLE};
      END IF;
    END
    $$`);
}
