import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

/** Statement timeouts, and which pool each kind of work uses. */
describe('database pools', () => {
  describe('the request pool', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness({ worker: false, env: { DB_STATEMENT_TIMEOUT_MS: '300' } });
    });
    afterAll(async () => h.close());

    it('cancels a statement that runs past DB_STATEMENT_TIMEOUT_MS', async () => {
      const error = await h.pool.query('SELECT pg_sleep(2)').catch((e: { code?: string }) => e);
      expect((error as { code?: string }).code).toBe('57014'); // query_canceled
    });

    it('names its connections, so they can be told apart in pg_stat_activity', async () => {
      const { rows } = await h.pool.query<{ name: string }>(`SELECT current_setting('application_name') AS name`);
      expect(rows[0]!.name).toBe('vault-test');
    });
  });

  describe('a read replica', () => {
    let h: Harness;
    let cookie: string;
    let workspaceId: string;

    beforeAll(async () => {
      // An unreachable "replica": whatever fails is exactly what is routed to it.
      const unreachable = 'postgres://filesharing:filesharing@localhost:5432/no_such_replica_database';
      h = await createHarness({ worker: false, env: { DATABASE_READ_URL: unreachable } });
      await h.truncate();
      ({ cookie, workspaceId } = await registerUser(h.app, 'alice@example.com'));
      await uploadDocument(h.app, cookie, workspaceId);
    });
    afterAll(async () => h.close());

    const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie } });

    it('serves the dashboard and audit trail', async () => {
      expect((await get(`/api/workspaces/${workspaceId}/overview`)).statusCode).toBe(500);
      expect((await get(`/api/workspaces/${workspaceId}/audit`)).statusCode).toBe(500);
    });

    it('is never used for reads that must see your own writes', async () => {
      expect((await get(`/api/workspaces/${workspaceId}/documents`)).statusCode).toBe(200);
      expect((await get('/api/auth/me')).statusCode).toBe(200);
      expect((await get('/api/notifications')).statusCode).toBe(200);
    });
  });

  describe('the direct pool', () => {
    let h: Harness;
    beforeAll(async () => {
      const unreachable = 'postgres://filesharing:filesharing@localhost:5432/no_such_direct_database';
      h = await createHarness({ worker: false, env: { DATABASE_DIRECT_URL: unreachable } });
    });
    afterAll(async () => h.close());

    it('holds the maintenance lock', async () => {
      await expect(h.app.maintenance.runOnce()).rejects.toThrow(/no_such_direct_database/);
    });

    it('is not used by ordinary requests', async () => {
      await h.truncate();
      const { cookie, workspaceId } = await registerUser(h.app, 'bob@example.com');
      expect(
        (await h.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/documents`, headers: { cookie } }))
          .statusCode,
      ).toBe(200);
    });
  });
});
