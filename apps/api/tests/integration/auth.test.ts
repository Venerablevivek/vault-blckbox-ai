import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, TEST_PASSWORD, type Harness } from '../helpers/harness';
import { hashToken } from '../../src/lib/tokens';

describe('authentication', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.truncate());

  it('registers, authenticates and signs out', async () => {
    const { cookie } = await registerUser(h.app, 'alice@example.com');

    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('alice@example.com');

    const logout = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    // Logout deletes the row, so the cookie is dead immediately — the reason for
    // server-side sessions rather than a stateless token.
    const after = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('sets an HttpOnly, SameSite=Lax cookie', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'alice@example.com', password: TEST_PASSWORD },
    });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('never stores the password or the session token in plaintext', async () => {
    const { cookie } = await registerUser(h.app, 'alice@example.com');
    const token = cookie.split('=')[1]!;

    const [user] = await h.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(user!.password_hash).toMatch(/^\$argon2id\$/);
    expect(user!.password_hash).not.toContain(TEST_PASSWORD);

    const [session] = await h.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
    expect(session!.token_hash.equals(hashToken(token))).toBe(true);
  });

  it('rejects a wrong password and an unknown account identically', async () => {
    await registerUser(h.app, 'alice@example.com');

    const wrongPassword = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: 'not-the-password' },
    });
    const unknownUser = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    // Identical body, so the response does not reveal which addresses have accounts.
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });

  it('expires a session once its lifetime has passed', async () => {
    const { cookie } = await registerUser(h.app, 'alice@example.com');
    h.clock.advanceHours(24 * h.config.SESSION_TTL_DAYS + 1);
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects a short password', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'x@example.com', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});
