import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  registerUser,
  uploadDocument,
  type Harness,
} from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('workspace management, rename, preview and overview', () => {
  let h: Harness;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  /** Bob joins Alice's workspace as a MEMBER. */
  async function addBob() {
    const invite = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: alice.cookie },
      payload: { email: 'bob@example.com', role: 'MEMBER' },
    });
    const token = invite.json().inviteUrl.split('/invite/')[1];
    await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });
  }

  const call = (method: string, url: string, cookie: string, payload?: unknown) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    bob = await registerUser(h.app, 'bob@example.com');
  });

  // ---- membership --------------------------------------------------------------

  it('never lets a workspace lose its last owner', async () => {
    const members = `/api/workspaces/${alice.workspaceId}/members/${alice.userId}`;

    const demote = await call('PATCH', members, alice.cookie, { role: 'MEMBER' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('LAST_OWNER');

    const leave = await call('DELETE', members, alice.cookie);
    expect(leave.statusCode).toBe(409);
  });

  it('allows the original owner to step down once another owner exists', async () => {
    await addBob();
    const promote = await call(
      'PATCH', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie, { role: 'OWNER' },
    );
    expect(promote.statusCode).toBe(204);

    const demoteSelf = await call(
      'PATCH', `/api/workspaces/${alice.workspaceId}/members/${alice.userId}`, alice.cookie, { role: 'MEMBER' },
    );
    expect(demoteSelf.statusCode).toBe(204);

    const [row] = await h.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = $1 AND role = 'OWNER'`,
      [alice.workspaceId],
    );
    expect(Number(row!.count)).toBe(1);
  });

  it('cannot end with zero owners even when two owners demote each other at once', async () => {
    await addBob();
    await call('PATCH', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie, { role: 'OWNER' });

    // Each owner tries to demote the other simultaneously. Without the row lock both would
    // see "another owner exists" and both would succeed.
    const results = await Promise.all([
      call('PATCH', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie, { role: 'MEMBER' }),
      call('PATCH', `/api/workspaces/${alice.workspaceId}/members/${alice.userId}`, bob.cookie, { role: 'MEMBER' }),
    ]);

    const [row] = await h.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = $1 AND role = 'OWNER'`,
      [alice.workspaceId],
    );
    expect(Number(row!.count)).toBeGreaterThanOrEqual(1);
    expect(results.map((r) => r.statusCode).sort()).toContain(204);
  });

  it('removes a member and cuts off their access on the next request', async () => {
    await addBob();
    await uploadDocument(h.app, bob.cookie, alice.workspaceId, 'bobs.pdf');

    expect((await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, bob.cookie)).statusCode).toBe(200);

    const remove = await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie);
    expect(remove.statusCode).toBe(204);

    // Same session cookie, no re-login: membership is read per request, so this is immediate.
    expect((await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, bob.cookie)).statusCode).toBe(404);

    // The documents stay with the workspace — they were never Bob's personal property.
    const docs = await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, alice.cookie);
    expect(docs.json().documents.map((d: { filename: string }) => d.filename)).toContain('bobs.pdf');
  });

  it('lets a member leave, but not remove anyone else', async () => {
    await addBob();
    const kick = await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${alice.userId}`, bob.cookie);
    expect(kick.statusCode).toBe(403);

    const leave = await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, bob.cookie);
    expect(leave.statusCode).toBe(204);
  });

  it('forbids a member from changing roles, and hides the workspace from outsiders', async () => {
    const outsider = await call(
      'PATCH', `/api/workspaces/${alice.workspaceId}/members/${alice.userId}`, bob.cookie, { role: 'MEMBER' },
    );
    expect(outsider.statusCode).toBe(404);

    await addBob();
    const member = await call(
      'PATCH', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, bob.cookie, { role: 'OWNER' },
    );
    // A member cannot promote themselves.
    expect(member.statusCode).toBe(403);
  });

  it('revokes a pending invitation so its link stops working', async () => {
    const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
      email: 'carol@example.com',
    });
    const id = invite.json().invitation.id;
    const token = invite.json().inviteUrl.split('/invite/')[1];

    expect((await call('DELETE', `/api/workspaces/${alice.workspaceId}/invitations/${id}`, alice.cookie)).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: `/api/invitations/${token}` })).statusCode).toBe(404);
  });

  it('audits membership changes', async () => {
    await addBob();
    await call('PATCH', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie, { role: 'OWNER' });
    await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie);

    const events = (await call('GET', `/api/workspaces/${alice.workspaceId}/audit`, alice.cookie)).json().events;
    const actions = events.map((e: { action: string }) => e.action);
    expect(actions).toContain('member.role_changed');
    expect(actions).toContain('member.removed');
  });

  // ---- rename ------------------------------------------------------------------

  it('renames a document without moving its bytes', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'draft.pdf');
    const id = upload.json().document.id;
    const [before] = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [id]);

    const rename = await call('PATCH', `/api/documents/${id}`, alice.cookie, { filename: 'final.pdf' });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().document.filename).toBe('final.pdf');

    const [after] = await h.query<{ storage_key: string; filename: string }>(
      'SELECT storage_key, filename FROM documents WHERE id = $1', [id],
    );
    expect(after!.filename).toBe('final.pdf');
    expect(after!.storage_key).toBe(before!.storage_key);
  });

  it('only lets the uploader or an owner rename', async () => {
    await addBob();
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'alices.pdf');
    const id = upload.json().document.id;

    expect((await call('PATCH', `/api/documents/${id}`, bob.cookie, { filename: 'x.pdf' })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/workspaces/${alice.workspaceId}`, bob.cookie, { name: 'Mine' })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { name: 'Team' })).statusCode).toBe(200);
  });

  // ---- preview -----------------------------------------------------------------

  it('previews a PDF inline but refuses types that browsers would sniff', async () => {
    const pdf = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'view.pdf');
    const preview = await call('GET', `/api/documents/${pdf.json().document.id}/preview`, alice.cookie);
    expect(preview.statusCode).toBe(302);
    expect(decodeURIComponent(preview.headers.location as string)).toContain('inline;');

    const csv = await uploadDocument(
      h.app, alice.cookie, alice.workspaceId, 'data.csv', Buffer.from('a,b\n1,2\n'), 'text/csv',
    );
    const refused = await call('GET', `/api/documents/${csv.json().document.id}/preview`, alice.cookie);
    expect(refused.statusCode).toBe(415);

    // Downloads stay attachments.
    const download = await call('GET', `/api/documents/${pdf.json().document.id}/download`, alice.cookie);
    expect(decodeURIComponent(download.headers.location as string)).toContain('attachment;');
  });

  // ---- overview ----------------------------------------------------------------

  it('summarises a workspace, and shows recent activity to owners only', async () => {
    await addBob();
    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'a.pdf');
    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'b.csv', Buffer.from('x,y\n'), 'text/csv');

    const owner = (await call('GET', `/api/workspaces/${alice.workspaceId}/overview`, alice.cookie)).json();
    expect(owner.totals.documents).toBe(2);
    expect(owner.totals.members).toBe(2);
    expect(owner.series).toHaveLength(14);
    expect(owner.storageByType.map((c: { category: string }) => c.category).sort()).toEqual(['PDF', 'Spreadsheets']);
    expect(Array.isArray(owner.recentActivity)).toBe(true);

    const member = (await call('GET', `/api/workspaces/${alice.workspaceId}/overview`, bob.cookie)).json();
    expect(member.totals.documents).toBe(2);
    expect(member.recentActivity).toBeNull();

    const outsider = await registerUser(h.app, 'eve@example.com');
    expect((await call('GET', `/api/workspaces/${alice.workspaceId}/overview`, outsider.cookie)).statusCode).toBe(404);
  });
});
