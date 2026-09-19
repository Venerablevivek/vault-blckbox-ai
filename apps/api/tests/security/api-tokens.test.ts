import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allOperations } from '../../src/openapi/document';
import { createHarness, registerUser, TEST_PASSWORD, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('API tokens', () => {
  let h: Harness;
  let alice: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
  });

  const withCookie = (method: string, url: string, payload?: object) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie: alice.cookie }, ...(payload ? { payload } : {}) });
  const withToken = (
    token: string,
    method: string,
    url: string,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, ...extra },
      ...(payload ? { payload } : {}),
    });

  async function createToken(scopes: string[], extra: object = {}): Promise<{ id: string; secret: string }> {
    const res = await withCookie('POST', '/api/auth/tokens', { name: 'script', scopes, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().token;
  }

  it('is shown once, listed only by its prefix, and announced by email', async () => {
    const res = await withCookie('POST', '/api/auth/tokens', { name: '  nightly backup ', scopes: ['read'] });
    const { token } = res.json();
    expect(token.secret).toMatch(/^vlt_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({
      name: 'nightly backup',
      scopes: ['read'],
      prefix: token.secret.slice(0, 12),
      lastUsedAt: null,
    });

    const listed = (await withCookie('GET', '/api/auth/tokens')).json().tokens;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    const [row] = await h.query<{ token_hash: Buffer }>('SELECT token_hash FROM api_tokens');
    expect(row!.token_hash.toString('latin1')).not.toContain(token.secret);

    const notice = await h.mailer.waitFor((m) => m.to === 'alice@example.com' && m.subject.includes('API token'));
    expect(notice.text).toContain('"nightly backup"');
  });

  it('acts as its owner: a read token only reads, a write token can change things', async () => {
    const reader = await createToken(['read']);
    const writer = await createToken(['write']);

    expect((await withToken(reader.secret, 'GET', '/api/workspaces')).statusCode).toBe(200);
    const refused = await withToken(reader.secret, 'POST', `/api/workspaces/${alice.workspaceId}/folders`, {
      name: 'X',
    });
    expect(refused.statusCode).toBe(403);

    const made = await withToken(writer.secret, 'POST', `/api/workspaces/${alice.workspaceId}/folders`, { name: 'Y' });
    expect(made.statusCode).toBe(201);
    const [event] = await h.query<{ actor_user_id: string }>(
      `SELECT actor_user_id FROM audit_events WHERE action = 'folder.created'`,
    );
    expect(event!.actor_user_id).toBe(alice.userId);

    const [used] = await h.query<{ last_used_at: Date | null }>('SELECT last_used_at FROM api_tokens WHERE id = $1', [
      writer.id,
    ]);
    expect(used!.last_used_at).not.toBeNull();
  });

  it('is refused, even with write access, wherever a signed-in browser is required', async () => {
    const writer = await createToken(['write']);
    const browserOnly = allOperations.filter((op) => op.browserOnly);
    expect(browserOnly.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort()).toEqual([
      'DELETE /api/auth/sessions',
      'DELETE /api/auth/sessions/:sessionId',
      'DELETE /api/auth/tokens/:id',
      'DELETE /api/workspaces/:id',
      'GET /api/auth/sessions',
      'GET /api/auth/tokens',
      'POST /api/auth/email/resend',
      'POST /api/auth/password',
      'POST /api/auth/tokens',
    ]);
    for (const op of browserOnly) {
      const url = op.path.replace(/:[A-Za-z]+/g, alice.workspaceId);
      const res = await withToken(writer.secret, op.method.toUpperCase(), url, op.method === 'get' ? undefined : {});
      expect(res.statusCode, `${op.method} ${op.path}`).toBe(403);
    }
    // The workspace is still there.
    expect((await withToken(writer.secret, 'GET', '/api/workspaces')).json().workspaces).toHaveLength(1);
  });

  it('never quietly falls back to a cookie when the token is bad', async () => {
    const res = await withToken(
      'vlt_not-a-real-token-at-all-aaaaaaaaaaaaaaaaaaaaa',
      'GET',
      '/api/workspaces',
      undefined,
      {
        cookie: alice.cookie,
      },
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/workspaces', headers: { authorization: 'Basic abc' } }))
        .statusCode,
    ).toBe(401);
  });

  it('stops working when revoked, when it expires, or when the password changes', async () => {
    const revoked = await createToken(['read']);
    expect((await withCookie('DELETE', `/api/auth/tokens/${revoked.id}`)).statusCode).toBe(204);
    expect((await withToken(revoked.secret, 'GET', '/api/workspaces')).statusCode).toBe(401);

    const expiring = await createToken(['read'], { expiresInDays: 1 });
    expect((await withToken(expiring.secret, 'GET', '/api/workspaces')).statusCode).toBe(200);
    h.clock.advanceHours(25);
    expect((await withToken(expiring.secret, 'GET', '/api/workspaces')).statusCode).toBe(401);
    h.clock.reset();

    const kept = await createToken(['write']);
    const change = await withCookie('POST', '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'a-brand-new-passphrase',
    });
    expect(change.statusCode).toBe(200);
    expect((await withToken(kept.secret, 'GET', '/api/workspaces')).statusCode).toBe(401);
  });

  it("belongs to one person: others can't see or revoke it, and there is a limit", async () => {
    const mine = await createToken(['read']);
    const bob = await registerUser(h.app, 'bob@example.com');
    const bobs = await h.app.inject({ method: 'GET', url: '/api/auth/tokens', headers: { cookie: bob.cookie } });
    expect(bobs.json().tokens).toEqual([]);
    const steal = await h.app.inject({
      method: 'DELETE',
      url: `/api/auth/tokens/${mine.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(steal.statusCode).toBe(404);

    for (let i = 1; i < 25; i += 1) await createToken(['read']);
    const over = await withCookie('POST', '/api/auth/tokens', { name: 'one too many', scopes: ['read'] });
    expect(over.statusCode).toBe(409);
    expect((await withCookie('POST', '/api/auth/tokens', { name: '', scopes: ['read'] })).statusCode).toBe(400);
    expect((await withCookie('POST', '/api/auth/tokens', { name: 'x', scopes: ['admin'] })).statusCode).toBe(400);
  });
});
