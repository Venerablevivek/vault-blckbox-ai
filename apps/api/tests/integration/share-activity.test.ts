import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

/**
 * Share-link access visibility.
 *
 * The product question is "did they open it?", so the assertions are about what the
 * sender can see — and, just as importantly, what is never recorded about the visitor.
 */
describe('share access visibility', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<typeof registerUser>>;
  let documentId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'contract.pdf');
    documentId = upload.json().document.id;
  });

  async function createShare() {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId },
    });
    const share = response.json().share;
    return { id: share.id as string, token: (share.url as string).split('/s/')[1]! };
  }

  async function activity() {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/shares`,
      headers: { cookie: alice.cookie },
    });
    return response.json().shares[0].activity;
  }

  /** Events are written fire-and-forget, so give the insert a tick to land. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it('reports a brand new link as never opened', async () => {
    await createShare();
    expect(await activity()).toMatchObject({ opens: 0, distinctViewers: 0, lastAccessedAt: null });
  });

  it('counts a view and a download separately, as one visitor', async () => {
    const { token } = await createShare();

    await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` });
    await h.app.inject({ method: 'GET', url: `/api/shares/${token}/download` });
    await settle();

    const result = await activity();
    // Previously a view followed by a download counted as two "opens".
    expect(result.opens).toBe(1);
    expect(result.downloads).toBe(1);
    expect(result.distinctViewers).toBe(1);
    expect(result.firstAccessedAt).not.toBeNull();
    expect(result.lastAccessedAt).not.toBeNull();
  });

  it('distinguishes viewers by address, which is the forwarding signal', async () => {
    const { token } = await createShare();

    for (const ip of ['203.0.113.10', '203.0.113.11', '198.51.100.7', '203.0.113.10']) {
      await h.app.inject({
        method: 'POST',
        url: `/api/shares/${token}/view`,
        headers: { 'x-forwarded-for': ip },
      });
    }
    await settle();

    const result = await activity();
    // Three distinct addresses; the repeat visit inside 30 minutes is not a new open.
    expect(result.opens).toBe(3);
    expect(result.distinctViewers).toBe(3);
  });

  it('does not count the server-rendered metadata lookup at all', async () => {
    const { token } = await createShare();

    // This is what the web server calls while rendering the share page. Its address is the
    // web container's, so counting it made every visitor look like the same person.
    for (const ip of ['203.0.113.10', '198.51.100.7']) {
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/shares/${token}`,
        headers: { 'x-forwarded-for': ip },
      });
      expect(response.statusCode).toBe(200);
    }
    await settle();

    expect(await activity()).toMatchObject({ opens: 0, downloads: 0, distinctViewers: 0 });
  });

  it('counts a refresh once, then again after 30 minutes', async () => {
    const { token } = await createShare();
    const view = () =>
      h.app.inject({
        method: 'POST',
        url: `/api/shares/${token}/view`,
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });

    await view();
    await settle();
    await view();
    await settle();
    await view();
    await settle();
    expect((await activity()).opens).toBe(1);

    h.clock.advanceHours(0.6); // 36 minutes
    await view();
    await settle();
    expect((await activity()).opens).toBe(2);
  });

  it('ignores link-preview bots', async () => {
    const { token } = await createShare();

    for (const agent of ['Slackbot-LinkExpanding 1.0', 'LinkedInBot/1.0', 'WhatsApp/2.23.20.0']) {
      await h.app.inject({
        method: 'POST',
        url: `/api/shares/${token}/view`,
        headers: { 'user-agent': agent },
      });
      await h.app.inject({
        method: 'GET',
        url: `/api/shares/${token}/download`,
        headers: { 'user-agent': agent },
      });
    }
    await settle();

    expect(await activity()).toMatchObject({ opens: 0, downloads: 0, distinctViewers: 0 });
  });

  it('records attempts on a revoked link, which is the point of keeping them', async () => {
    const { id, token } = await createShare();

    await h.app.inject({ method: 'DELETE', url: `/api/shares/${id}`, headers: { cookie: alice.cookie } });
    expect((await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` })).statusCode).toBe(410);
    await settle();

    // A revoked link drops out of the document's live list, so its history is read from
    // the events endpoint — which still resolves by id.
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/shares/${id}/events`,
      headers: { cookie: alice.cookie },
    });
    const events = response.json().events;
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('revoked');
  });

  it('records an attempt on a link whose document was deleted', async () => {
    const { id, token } = await createShare();

    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });
    expect((await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` })).statusCode).toBe(410);
    await settle();

    const response = await h.app.inject({
      method: 'GET',
      url: `/api/shares/${id}/events`,
      headers: { cookie: alice.cookie },
    });
    expect(response.json().events[0].outcome).toBe('document_deleted');
  });

  it('never stores a raw IP address', async () => {
    const { token } = await createShare();
    await h.app.inject({
      method: 'POST',
      url: `/api/shares/${token}/view`,
      headers: { 'x-forwarded-for': '203.0.113.42' },
    });
    await settle();

    const rows = await h.query<{ ip_hash: Buffer }>('SELECT ip_hash FROM share_access_events');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip_hash).toHaveLength(32);
    expect(rows[0]!.ip_hash.toString('utf8')).not.toContain('203.0.113.42');
    expect(rows[0]!.ip_hash.toString('hex')).not.toContain('203.0.113.42');
  });

  it('exposes an access history without exposing the visitor', async () => {
    const { id, token } = await createShare();
    await h.app.inject({
      method: 'POST',
      url: `/api/shares/${token}/view`,
      headers: { 'x-forwarded-for': '203.0.113.42', 'user-agent': 'Mozilla/5.0 (test)' },
    });
    await settle();

    const response = await h.app.inject({
      method: 'GET',
      url: `/api/shares/${id}/events`,
      headers: { cookie: alice.cookie },
    });

    expect(response.statusCode).toBe(200);
    const [event] = response.json().events;
    expect(event.outcome).toBe('resolved');
    expect(event.userAgent).toBe('Mozilla/5.0 (test)');
    // The sender sees a stable opaque marker, never an address.
    expect(event.viewer).toMatch(/^[0-9a-f]{8}$/);
    expect(response.body).not.toContain('203.0.113.42');
  });

  it('keeps access history private to the workspace', async () => {
    const { id } = await createShare();
    const bob = await registerUser(h.app, 'bob@example.com');

    const response = await h.app.inject({
      method: 'GET',
      url: `/api/shares/${id}/events`,
      headers: { cookie: bob.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('deletes access history along with the document', async () => {
    const { token } = await createShare();
    await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` });
    await settle();
    expect(await h.query('SELECT 1 FROM share_access_events')).toHaveLength(1);

    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });

    // Soft delete keeps the rows; they cascade only when the document row itself goes.
    await h.query('DELETE FROM documents WHERE id = $1', [documentId]);
    expect(await h.query('SELECT 1 FROM share_access_events')).toHaveLength(0);
  });
});
