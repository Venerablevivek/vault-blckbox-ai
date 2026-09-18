import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, TEST_APP_ROLE, uploadDocument, type Harness } from '../helpers/harness';

/**
 * The application connects as vault_app, a least-privilege role. These tests pin what it can and
 * cannot do, so a later grant can't quietly widen it.
 */
describe('database privileges of the application role', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ worker: false });
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.truncate());

  const asApp = (sql: string, params: unknown[] = []) => h.pool.query(sql, params);
  const denied = async (sql: string) => {
    const error = (await asApp(sql).catch((e: unknown) => e)) as { code?: string };
    return error.code;
  };

  it('is not a superuser and does not bypass row-level security', async () => {
    const { rows } = await asApp(
      'SELECT current_user AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({
      name: TEST_APP_ROLE,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it('cannot create, alter, drop or truncate tables', async () => {
    expect(await denied('CREATE TABLE sneaky (id int)')).toBe('42501');
    expect(await denied('ALTER TABLE documents ADD COLUMN sneaky int')).toBe('42501');
    expect(await denied('DROP TABLE rate_limits')).toBe('42501');
    expect(await denied('TRUNCATE users')).toBe('42501');
  });

  it('cannot read or change the migration ledger', async () => {
    expect(await denied('SELECT * FROM schema_migrations')).toBe('42501');
  });

  it('can add to the audit trail and read it, but never change or delete it', async () => {
    const { workspaceId } = await registerUser(h.app, 'alice@example.com');
    const { rows } = await asApp('SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1', [workspaceId]);
    expect(rows[0].n).toBeGreaterThan(0);
    expect(await denied(`UPDATE audit_events SET action = 'document.deleted'`)).toBe('42501');
    expect(await denied('DELETE FROM audit_events')).toBe('42501');
    expect(await denied('TRUNCATE audit_events')).toBe('42501');
  });

  it('still removes a deleted workspace, audit trail included, through the foreign-key cascade', async () => {
    const alice = await registerUser(h.app, 'alice@example.com');
    await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const workspace = (
      await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: alice.cookie } })
    ).json().workspaces[0];
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${alice.workspaceId}`,
      headers: { cookie: alice.cookie },
      payload: { confirmName: workspace.name },
    });
    expect(response.statusCode).toBe(204);
    await h.runJobs();
    expect(await h.query('SELECT 1 FROM workspaces WHERE id = $1', [alice.workspaceId])).toHaveLength(0);
    expect(await h.query('SELECT 1 FROM audit_events WHERE workspace_id = $1', [alice.workspaceId])).toHaveLength(0);
  });

  it('keeps share-event partitions through owner-run functions', async () => {
    const { rows } = await asApp(`SELECT count(*)::int AS n FROM drop_share_event_partitions_before('2000-01-01')`);
    expect(rows[0].n).toBe(0);
    await asApp(`SELECT ensure_share_event_partitions('2030-06-01', 1)`);
    const partitions = await h.query(`SELECT 1 FROM pg_class WHERE relname = 'share_access_events_2030_06'`);
    expect(partitions).toHaveLength(1);
    await h.query('DROP TABLE share_access_events_2030_06');
  });
});
