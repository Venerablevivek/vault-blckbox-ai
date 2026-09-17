import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';
import { grantCookieName, LINK_PASSWORD_ATTEMPTS } from '../../src/modules/shares/shares.service';

type User = Awaited<ReturnType<typeof registerUser>>;

/** Password-protected, one-time and download-limited links, and editing a link. */
describe('protected share links', () => {
  let h: Harness;
  let alice: User;
  let documentId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    documentId = (await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'salary-bands.pdf')).json().document.id;
  });

  async function createLink(settings: Record<string, unknown> = {}) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId, ...settings },
    });
    expect(response.statusCode).toBe(201);
    const share = response.json().share;
    return { id: share.id as string, token: (share.url as string).split('/s/')[1]! };
  }

  const publicGet = (url: string, cookie?: string) =>
    h.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  async function unlock(token: string, password: string, ip = '203.0.113.5') {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/shares/${token}/unlock`,
      headers: { 'x-forwarded-for': ip },
      payload: { password },
    });
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return { response, cookie: raw ? raw.split(';')[0]! : undefined };
  }

  describe('password protection', () => {
    it('reveals nothing about the document until the password is entered', async () => {
      const { token } = await createLink({ password: 'correct-horse' });
      const response = await publicGet(`/api/shares/${token}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ requiresPassword: true });
      expect(response.body).not.toContain('salary-bands');
      expect(response.body).not.toContain('application/pdf');
    });

    it('refuses view and download without the password', async () => {
      const { token } = await createLink({ password: 'correct-horse' });
      expect((await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view` })).statusCode).toBe(401);
      expect((await publicGet(`/api/shares/${token}/download`)).json().error.code).toBe('PASSWORD_REQUIRED');
    });

    it('unlocks with the right password, for this link only', async () => {
      const first = await createLink({ password: 'correct-horse' });
      const second = await createLink({ password: 'correct-horse' });

      const { response, cookie } = await unlock(first.token, 'correct-horse');
      expect(response.statusCode).toBe(204);
      expect(cookie).toBeDefined();
      expect(String(response.headers['set-cookie'])).toContain('HttpOnly');

      const metadata = await publicGet(`/api/shares/${first.token}`, cookie);
      expect(metadata.json()).toMatchObject({ requiresPassword: false, filename: 'salary-bands.pdf' });
      expect((await publicGet(`/api/shares/${first.token}/download`, cookie)).statusCode).toBe(302);

      // Each link has its own grant cookie; unlocking one does not unlock another.
      expect(grantCookieName(first.token)).not.toBe(grantCookieName(second.token));
      const otherValue = cookie!.split('=')[1];
      const forged = `${grantCookieName(second.token)}=${otherValue}`;
      expect((await publicGet(`/api/shares/${second.token}`, forged)).json().requiresPassword).toBe(true);
    });

    it('rejects a wrong password and records the attempt for the sender', async () => {
      const { id, token } = await createLink({ password: 'correct-horse' });
      const { response } = await unlock(token, 'wrong');
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('WRONG_PASSWORD');

      const events = await h.app.inject({ method: 'GET', url: `/api/shares/${id}/events`, headers: { cookie: alice.cookie } });
      expect(events.json().events[0].outcome).toBe('bad_password');
    });

    it('locks the link after repeated wrong passwords, from any address, even for the right password', async () => {
      const { token } = await createLink({ password: 'correct-horse' });
      for (let i = 0; i < LINK_PASSWORD_ATTEMPTS; i += 1) {
        // A different address each time: per-IP limits alone would never trip.
        await unlock(token, `guess-${i}`, `198.51.100.${i + 1}`);
      }
      const { response } = await unlock(token, 'correct-horse', '192.0.2.200');
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('LINK_LOCKED');
      expect(response.headers['retry-after']).toBeDefined();
    });

    it('invalidates existing unlocks when the password is changed', async () => {
      const { id, token } = await createLink({ password: 'correct-horse' });
      const { cookie } = await unlock(token, 'correct-horse');
      expect((await publicGet(`/api/shares/${token}`, cookie)).json().requiresPassword).toBe(false);

      await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: alice.cookie }, payload: { password: 'new-password' } });

      expect((await publicGet(`/api/shares/${token}`, cookie)).json().requiresPassword).toBe(true);
    });

    it('never stores the link password in plaintext', async () => {
      await createLink({ password: 'correct-horse' });
      const [row] = await h.query<{ password_hash: string }>('SELECT password_hash FROM shares');
      expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    });
  });

  describe('download limits', () => {
    it('lets a one-time link be downloaded exactly once', async () => {
      const { token } = await createLink({ maxDownloads: 1 });
      expect((await publicGet(`/api/shares/${token}/download`)).statusCode).toBe(302);
      const second = await publicGet(`/api/shares/${token}/download`);
      expect(second.statusCode).toBe(410);
      expect(second.json().error.message).toMatch(/download limit/);
      expect((await publicGet(`/api/shares/${token}`)).statusCode).toBe(410);
    });

    it('never lets concurrent downloads exceed the limit', async () => {
      const { token } = await createLink({ maxDownloads: 1 });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => publicGet(`/api/shares/${token}/download`)),
      );
      expect(results.filter((r) => r.statusCode === 302)).toHaveLength(1);
      const [row] = await h.query<{ download_count: number }>('SELECT download_count FROM shares');
      expect(row!.download_count).toBe(1);
    });

    it('does not let a link-preview bot use up a one-time link', async () => {
      const { token } = await createLink({ maxDownloads: 1 });
      const bot = await h.app.inject({
        method: 'GET',
        url: `/api/shares/${token}/download`,
        headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' },
      });
      expect(bot.statusCode).toBe(403);
      expect((await publicGet(`/api/shares/${token}/download`)).statusCode).toBe(302);
    });

    it('reports downloads remaining', async () => {
      const { token } = await createLink({ maxDownloads: 3 });
      await publicGet(`/api/shares/${token}/download`);
      expect((await publicGet(`/api/shares/${token}`)).json().downloadsRemaining).toBe(2);
    });
  });

  describe('editing a link', () => {
    it('extends the expiry of an expired link, keeping the same URL', async () => {
      const { id, token } = await createLink({ expiresInHours: 1 });
      h.clock.advanceHours(2);
      expect((await publicGet(`/api/shares/${token}`)).statusCode).toBe(410);

      const edit = await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: alice.cookie }, payload: { expiresInHours: 24 } });
      expect(edit.statusCode).toBe(200);
      expect((await publicGet(`/api/shares/${token}`)).statusCode).toBe(200);
    });

    it('can remove a password and a limit', async () => {
      const { id, token } = await createLink({ password: 'correct-horse', maxDownloads: 1 });
      await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: alice.cookie }, payload: { password: null, maxDownloads: null } });
      const metadata = (await publicGet(`/api/shares/${token}`)).json();
      expect(metadata).toMatchObject({ requiresPassword: false, downloadsRemaining: null });
    });

    it('refuses a limit at or below downloads already made', async () => {
      const { id, token } = await createLink({ maxDownloads: 5 });
      await publicGet(`/api/shares/${token}/download`);
      await publicGet(`/api/shares/${token}/download`);
      const edit = await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: alice.cookie }, payload: { maxDownloads: 2 } });
      expect(edit.statusCode).toBe(422);
    });

    it('cannot edit a revoked link', async () => {
      const { id } = await createLink();
      await h.app.inject({ method: 'DELETE', url: `/api/shares/${id}`, headers: { cookie: alice.cookie } });
      const edit = await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: alice.cookie }, payload: { expiresInHours: 24 } });
      expect(edit.statusCode).toBe(409);
    });

    it("does not let a member edit someone else's link, or an outsider see it", async () => {
      const { id } = await createLink();
      const bob = await registerUser(h.app, 'bob@example.com');
      expect((await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: bob.cookie }, payload: { expiresInHours: 1 } })).statusCode).toBe(404);

      const invite = await h.app.inject({ method: 'POST', url: `/api/workspaces/${alice.workspaceId}/invitations`, headers: { cookie: alice.cookie }, payload: { email: 'bob@example.com', role: 'MEMBER' } });
      await h.app.inject({ method: 'POST', url: `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`, headers: { cookie: bob.cookie } });
      expect((await h.app.inject({ method: 'PATCH', url: `/api/shares/${id}`, headers: { cookie: bob.cookie }, payload: { expiresInHours: 1 } })).statusCode).toBe(403);
    });
  });
});
