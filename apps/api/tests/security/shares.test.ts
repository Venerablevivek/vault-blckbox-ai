import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';
import { hashToken } from '../../src/lib/tokens';

/**
 * Blueprint test area 2: "Valid link works; expired/revoked/invalid links fail."
 */
describe('share links', () => {
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

  async function createShare(expiresInHours?: number | null) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId, ...(expiresInHours !== undefined ? { expiresInHours } : {}) },
    });
    const share = response.json().share;
    return { id: share.id as string, token: (share.url as string).split('/s/')[1]!, url: share.url };
  }

  it('resolves a valid link for an anonymous visitor and exposes metadata only', async () => {
    const { token } = await createShare();

    const response = await h.app.inject({ method: 'GET', url: `/api/shares/${token}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.filename).toBe('contract.pdf');
    // Nothing that would reveal the storage layout or the team behind the link.
    const raw = response.body;
    expect(raw).not.toContain('storage_key');
    expect(raw).not.toContain('workspaces/');
    expect(raw).not.toContain('alice@example.com');
  });

  it('redirects a download to a short-lived signed URL', async () => {
    const { token } = await createShare();
    const response = await h.app.inject({ method: 'GET', url: `/api/shares/${token}/download` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('X-Amz-Signature');
    // The URL must be signed against the browser-reachable host, not the internal one.
    expect(response.headers.location).toContain('localhost:9000');
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const { token } = await createShare();
    const rows = await h.query<{ token_hash: Buffer }>('SELECT token_hash FROM shares');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.equals(hashToken(token))).toBe(true);
    expect(rows[0]!.token_hash.toString('utf8')).not.toContain(token);
  });

  it('returns 410 immediately after revocation', async () => {
    const { id, token } = await createShare();
    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(200);

    const revoke = await h.app.inject({
      method: 'DELETE',
      url: `/api/shares/${id}`,
      headers: { cookie: alice.cookie },
    });
    expect(revoke.statusCode).toBe(204);

    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(410);
    expect(
      (await h.app.inject({ method: 'GET', url: `/api/shares/${token}/download` })).statusCode,
    ).toBe(410);
  });

  it('returns 410 once the link has expired', async () => {
    const { token } = await createShare(1);
    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(200);

    h.clock.advanceHours(2); // move time rather than sleeping

    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(410);
  });

  it('honours a link created with no expiry', async () => {
    const { token } = await createShare(null);
    h.clock.advanceHours(24 * 365);
    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(200);
  });

  it('returns 404 for a token that never existed', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/shares/shr_madeupvalue000000' });
    expect(response.statusCode).toBe(404);
  });

  it('dies the moment its document is deleted', async () => {
    const { token } = await createShare();

    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });

    // No cleanup pass runs: the resolve query joins documents and requires deleted_at IS NULL.
    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(410);
  });

  it('does not return the token when listing a document\'s links', async () => {
    const { token } = await createShare();
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/shares`,
      headers: { cookie: alice.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(token);
  });
});
