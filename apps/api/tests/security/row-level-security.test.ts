import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/db/tenant';
import { documentsRepo } from '../../src/modules/documents/documents.repo';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/**
 * Row-level security as a second line of defence: inside a tenant context the database itself
 * hides other workspaces' rows, even from a query that forgot to filter by workspace. These tests
 * run as the application role (vault_app), which RLS applies to.
 */
describe('row-level security', () => {
  let h: Harness;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    bob = await registerUser(h.app, 'bob@example.com');
    const doc = (await uploadDocument(h.app, bob.cookie, bob.workspaceId, 'bob-secret.pdf')).json().document;
    await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: bob.cookie },
      payload: { documentId: doc.id },
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${bob.workspaceId}/folders`,
      headers: { cookie: bob.cookie },
      payload: { name: 'Bob only' },
    });
    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'alice.pdf');
    await h.drainJobs();
  });

  const countAs = (userId: string, table: string) =>
    withTenant(h.pool, userId, async (db) =>
      Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n),
    );

  it('is enabled on every tenant table', async () => {
    const rows = await h.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('documents','folders','uploads','audit_events','shares','notifications')`,
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('hides other workspaces from an unfiltered query', async () => {
    for (const table of ['documents', 'folders', 'shares', 'audit_events']) {
      const bobs = await countAs(bob.userId, table);
      const alices = await countAs(alice.userId, table);
      const all = Number((await h.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n);
      expect(bobs + alices, table).toBe(all);
      expect(bobs, table).toBeGreaterThan(0);
    }
    expect(await countAs(alice.userId, 'folders')).toBe(0);
    expect(await countAs(alice.userId, 'shares')).toBe(0);
  });

  it('returns nothing when a listing is pointed at another workspace, as a missing membership check would', async () => {
    const rows = await withTenant(h.pool, alice.userId, (db) =>
      documentsRepo.list(db, {
        workspaceId: bob.workspaceId,
        view: 'active',
        folderId: null,
        search: null,
        filter: 'all',
        sort: 'date',
        ascending: false,
        userId: alice.userId,
        limit: 50,
        after: null,
      }),
    );
    expect(rows).toHaveLength(0);
    // Without the tenant context (system work), the same query sees the row.
    const system = await documentsRepo.list(h.pool, {
      workspaceId: bob.workspaceId,
      view: 'active',
      folderId: null,
      search: null,
      filter: 'all',
      sort: 'date',
      ascending: false,
      userId: alice.userId,
      limit: 50,
      after: null,
    });
    expect(system).toHaveLength(1);
  });

  it('shows a user only their own notifications', async () => {
    await h.query(
      `INSERT INTO notifications (id, user_id, workspace_id, type, title, created_at)
       VALUES (gen_random_uuid(), $1, NULL, 'workspace.deleted', 'for bob', now())`,
      [bob.userId],
    );
    expect(await countAs(alice.userId, 'notifications')).toBe(0);
    expect(await countAs(bob.userId, 'notifications')).toBe(1);
  });

  it('never leaks the tenant setting to the next query on the same connection', async () => {
    await countAs(alice.userId, 'documents');
    const { rows } = await h.pool.query(`SELECT COALESCE(current_setting('app.user_id', true), '') AS v`);
    expect(rows[0].v).toBe('');
  });

  it('keeps the API working for members', async () => {
    const list = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bob.workspaceId}/documents`,
      headers: { cookie: bob.cookie },
    });
    expect(list.json().documents.map((d: { filename: string }) => d.filename)).toEqual(['bob-secret.pdf']);
    const overview = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bob.workspaceId}/overview`,
      headers: { cookie: bob.cookie },
    });
    expect(overview.json().totals.documents).toBe(1);
  });
});
