import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

/** Audit and notification writes are fire-and-forget; give them a tick to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('audit trail and notifications', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
  });

  async function auditFor(workspaceId: string, cookie: string) {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/audit`,
      headers: { cookie },
    });
    return response;
  }

  async function inbox(cookie: string) {
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie },
    });
    return response.json();
  }

  // ---- audit ---------------------------------------------------------------

  it('records the lifecycle of a document', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'contract.pdf');
    const documentId = upload.json().document.id;

    await h.app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/download`,
      headers: { cookie: alice.cookie },
    });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });
    await settle();

    const events = (await auditFor(alice.workspaceId, alice.cookie)).json().events;
    const actions = events.map((e: { action: string }) => e.action);

    expect(actions).toContain('workspace.created');
    expect(actions).toContain('document.uploaded');
    expect(actions).toContain('document.downloaded');
    expect(actions).toContain('document.trashed');
  });

  it('keeps the trail after the document it describes is gone', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'gone.pdf');
    const documentId = upload.json().document.id;

    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });
    // Hard-delete the row, as the retention story eventually would.
    await h.query('DELETE FROM documents WHERE id = $1', [documentId]);
    await settle();

    const events = (await auditFor(alice.workspaceId, alice.cookie)).json().events;
    const uploaded = events.find((e: { action: string }) => e.action === 'document.uploaded');

    // An audit log that can be erased by deleting its subject is not an audit log. The
    // filename survives in metadata precisely because the document no longer exists.
    expect(uploaded).toBeDefined();
    expect(uploaded.metadata.filename).toBe('gone.pdf');
  });

  it('records anonymous share access with no actor', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: upload.json().document.id },
    });
    const token = share.json().share.url.split('/s/')[1];

    await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` });
    await settle();

    const events = (await auditFor(alice.workspaceId, alice.cookie)).json().events;
    const accessed = events.find((e: { action: string }) => e.action === 'share.accessed');

    expect(accessed).toBeDefined();
    expect(accessed.actorEmail).toBeNull();
  });

  it('is owner-only, and invisible to outsiders', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');

    // Outsider: 404, identical to a workspace that does not exist.
    expect((await auditFor(alice.workspaceId, bob.cookie)).statusCode).toBe(404);

    // Member without the role: 403, because they can already see the workspace exists.
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

    expect((await auditFor(alice.workspaceId, bob.cookie)).statusCode).toBe(403);
  });

  // ---- notifications -------------------------------------------------------

  it('tells the link creator the first time their link is opened', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'offer.pdf');
    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: upload.json().document.id },
    });
    const token = share.json().share.url.split('/s/')[1];

    expect((await inbox(alice.cookie)).unread).toBe(0);

    await h.app.inject({
      method: 'POST',
      url: `/api/shares/${token}/view`,
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    await settle();

    const first = await inbox(alice.cookie);
    expect(first.unread).toBe(1);
    expect(first.notifications[0]).toMatchObject({ type: 'share.first_open' });
    expect(first.notifications[0]!.title).toContain('offer.pdf');
  });

  it('does not notify again for the same viewer refreshing', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: upload.json().document.id },
    });
    const token = share.json().share.url.split('/s/')[1];

    for (let i = 0; i < 4; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: `/api/shares/${token}/view`,
        headers: { 'x-forwarded-for': '203.0.113.5' },
      });
      await settle();
    }

    // Four opens, one viewer, one notification. Refreshes must not become spam.
    expect((await inbox(alice.cookie)).unread).toBe(1);
  });

  it('warns about forwarding once a third network opens the link', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'nda.pdf');
    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: upload.json().document.id },
    });
    const token = share.json().share.url.split('/s/')[1];

    for (const ip of ['203.0.113.5', '198.51.100.9', '192.0.2.77']) {
      await h.app.inject({
        method: 'POST',
        url: `/api/shares/${token}/view`,
        headers: { 'x-forwarded-for': ip },
      });
      await settle();
    }

    const types = (await inbox(alice.cookie)).notifications.map((n) => n.type);
    expect(types).toContain('share.forwarding_suspected');
  });

  it('tells other members about an upload, but not the uploader', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
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
    await settle();

    // Alice is told that Bob joined.
    const aliceInbox = await inbox(alice.cookie);
    expect(aliceInbox.notifications.map((n) => n.type)).toContain('member.joined');

    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'deck.pdf');
    await settle();

    const bobInbox = await inbox(bob.cookie);
    expect(bobInbox.notifications.map((n) => n.type)).toContain('document.uploaded');

    // Alice uploaded it, so she is not told about her own action.
    const aliceAfter = await inbox(alice.cookie);
    expect(aliceAfter.notifications.filter((n) => n.type === 'document.uploaded')).toHaveLength(0);
  });

  it('marks notifications read, and only ever the caller\'s own', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: upload.json().document.id },
    });
    const token = share.json().share.url.split('/s/')[1];
    await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` });
    await settle();

    const before = await inbox(alice.cookie);
    expect(before.unread).toBe(1);
    const notificationId = before.notifications[0]!.id as string;

    // Bob tries to mark Alice's notification read: user_id is in the WHERE clause, so
    // this is a silent no-op rather than a cross-user write.
    await h.app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie: bob.cookie },
      payload: { id: notificationId },
    });
    expect((await inbox(alice.cookie)).unread).toBe(1);

    await h.app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie: alice.cookie },
      payload: {},
    });
    expect((await inbox(alice.cookie)).unread).toBe(0);
  });
});
