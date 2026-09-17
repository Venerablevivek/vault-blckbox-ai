import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, TEST_PASSWORD, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;
const NEW_PASSWORD = 'a-brand-new-passphrase';

/** Password reset, password change, session management and transactional email. */
describe('account security', () => {
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

  const call = (
    method: string,
    url: string,
    cookie?: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const cookieOf = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers['set-cookie'];
    return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
  };

  const login = async (password = TEST_PASSWORD, userAgent = 'test-agent') => {
    const response = await call(
      'POST',
      '/api/auth/login',
      undefined,
      { email: 'alice@example.com', password },
      { 'user-agent': userAgent },
    );
    return { response, cookie: response.statusCode === 200 ? cookieOf(response) : '' };
  };

  async function requestResetToken(email = 'alice@example.com'): Promise<string> {
    expect((await call('POST', '/api/auth/password/forgot', undefined, { email })).statusCode).toBe(202);
    const message = await h.mailer.waitFor((m) => m.to === email && m.subject.includes('Reset'));
    const match = /reset-password#token=(pwr_[A-Za-z0-9_-]+)/.exec(message.text);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  describe('forgotten password', () => {
    it('emails a single-use link, carried in the URL fragment', async () => {
      const token = await requestResetToken();
      expect(token).toMatch(/^pwr_[A-Za-z0-9_-]{43}$/);
      expect(h.mailer.sent).toHaveLength(1);
    });

    it('answers identically for an unknown address and sends nothing', async () => {
      const known = await call('POST', '/api/auth/password/forgot', undefined, { email: 'alice@example.com' });
      const unknown = await call('POST', '/api/auth/password/forgot', undefined, { email: 'nobody@example.com' });
      expect(unknown.statusCode).toBe(known.statusCode);
      expect(unknown.body).toBe(known.body);
      await h.mailer.waitFor((m) => m.to === 'alice@example.com');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(h.mailer.sent.map((m) => m.to)).toEqual(['alice@example.com']);
    });

    it('stores only a hash of the token', async () => {
      const token = await requestResetToken();
      const rows = await h.query<{ token_hash: Buffer }>('SELECT token_hash FROM password_resets');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash.length).toBe(32);
      expect(rows[0]!.token_hash.toString('utf8')).not.toContain(token);
    });

    it('resets the password, ends every session and signs this browser in', async () => {
      const other = await login();
      const token = await requestResetToken();

      const reset = await call('POST', '/api/auth/password/reset', undefined, { token, password: NEW_PASSWORD });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().signedOutSessions).toBe(2);

      expect((await call('GET', '/api/auth/me', alice.cookie)).statusCode).toBe(401);
      expect((await call('GET', '/api/auth/me', other.cookie)).statusCode).toBe(401);
      expect((await call('GET', '/api/auth/me', cookieOf(reset))).statusCode).toBe(200);

      expect((await login(TEST_PASSWORD)).response.statusCode).toBe(401);
      expect((await login(NEW_PASSWORD)).response.statusCode).toBe(200);
      await h.mailer.waitFor((m) => m.subject === 'Your Vault password was changed');
    });

    it('refuses a link twice, after it expires, and once a newer one has been used', async () => {
      const first = await requestResetToken();
      h.mailer.clear();
      const second = await requestResetToken();

      expect(
        (await call('POST', '/api/auth/password/reset', undefined, { token: second, password: NEW_PASSWORD }))
          .statusCode,
      ).toBe(200);
      const reused = await call('POST', '/api/auth/password/reset', undefined, {
        token: second,
        password: 'another-password-1',
      });
      expect(reused.statusCode).toBe(410);
      expect(reused.json().error.code).toBe('RESET_LINK_INVALID');
      expect(
        (await call('POST', '/api/auth/password/reset', undefined, { token: first, password: 'another-password-2' }))
          .statusCode,
      ).toBe(410);

      h.mailer.clear();
      const late = await requestResetToken();
      h.clock.advanceHours(1.1);
      expect(
        (await call('POST', '/api/auth/password/reset', undefined, { token: late, password: 'another-password-3' }))
          .statusCode,
      ).toBe(410);
    });

    it('lets exactly one of two simultaneous submissions of the same link succeed', async () => {
      const token = await requestResetToken();
      const results = await Promise.all([
        call('POST', '/api/auth/password/reset', undefined, { token, password: 'first-new-password' }),
        call('POST', '/api/auth/password/reset', undefined, { token, password: 'second-new-password' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    });

    it('sends at most three reset emails an hour to one account', async () => {
      for (let i = 0; i < 5; i++) {
        expect(
          (await call('POST', '/api/auth/password/forgot', undefined, { email: 'alice@example.com' })).statusCode,
        ).toBe(202);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(h.mailer.sent).toHaveLength(3);
    });

    it('lifts a login lockout, since the old password no longer matters', async () => {
      for (let i = 0; i < 5; i++) await login('wrong-password');
      expect((await login(TEST_PASSWORD)).response.statusCode).toBe(429);

      const token = await requestResetToken();
      await call('POST', '/api/auth/password/reset', undefined, { token, password: NEW_PASSWORD });
      expect((await login(NEW_PASSWORD)).response.statusCode).toBe(200);
    });
  });

  describe('changing the password', () => {
    it('requires the current password, and wrong guesses count toward the lockout', async () => {
      for (let i = 0; i < 5; i++) {
        const wrong = await call('POST', '/api/auth/password', alice.cookie, {
          currentPassword: `guess-${i}`,
          newPassword: NEW_PASSWORD,
        });
        expect(wrong.statusCode).toBe(400);
        expect(wrong.json().error.code).toBe('INCORRECT_PASSWORD');
      }
      const locked = await call('POST', '/api/auth/password', alice.cookie, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('ACCOUNT_LOCKED');
    });

    it('keeps this session, ends the others, and emails a notice', async () => {
      const other = await login();
      const changed = await call('POST', '/api/auth/password', alice.cookie, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({ signedOutSessions: 1 });

      expect((await call('GET', '/api/auth/me', alice.cookie)).statusCode).toBe(200);
      expect((await call('GET', '/api/auth/me', other.cookie)).statusCode).toBe(401);
      expect((await login(NEW_PASSWORD)).response.statusCode).toBe(200);
      await h.mailer.waitFor((m) => m.subject === 'Your Vault password was changed');
    });

    it('refuses the same password and a password that is too short', async () => {
      const same = await call('POST', '/api/auth/password', alice.cookie, {
        currentPassword: TEST_PASSWORD,
        newPassword: TEST_PASSWORD,
      });
      expect(same.json().error.code).toBe('PASSWORD_UNCHANGED');
      expect(
        (
          await call('POST', '/api/auth/password', alice.cookie, {
            currentPassword: TEST_PASSWORD,
            newPassword: 'short',
          })
        ).statusCode,
      ).toBe(400);
    });

    it('still succeeds when the notice email cannot be sent', async () => {
      h.mailer.failNext = true;
      const changed = await call('POST', '/api/auth/password', alice.cookie, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(changed.statusCode).toBe(200);
      expect((await login(NEW_PASSWORD)).response.statusCode).toBe(200);
    });
  });

  describe('sessions', () => {
    it('lists the account’s sessions with their browser, marking this one', async () => {
      await login(TEST_PASSWORD, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
      const list = await call('GET', '/api/auth/sessions', alice.cookie);
      expect(list.statusCode).toBe(200);
      const sessions = list.json().sessions as Array<{ current: boolean; userAgent: string | null }>;
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
      expect(sessions.some((s) => s.userAgent?.includes('iPhone'))).toBe(true);
    });

    it('signs out another session, which stops working at once', async () => {
      const other = await login();
      const sessions = (await call('GET', '/api/auth/sessions', alice.cookie)).json().sessions as Array<{
        id: string;
        current: boolean;
      }>;
      const target = sessions.find((s) => !s.current)!;

      expect((await call('DELETE', `/api/auth/sessions/${target.id}`, alice.cookie)).statusCode).toBe(204);
      expect((await call('GET', '/api/auth/me', other.cookie)).statusCode).toBe(401);
      expect((await call('GET', '/api/auth/me', alice.cookie)).statusCode).toBe(200);
    });

    it("cannot sign out someone else's session", async () => {
      const bob = await registerUser(h.app, 'bob@example.com');
      const bobSessions = (await call('GET', '/api/auth/sessions', bob.cookie)).json().sessions as Array<{
        id: string;
      }>;

      expect((await call('DELETE', `/api/auth/sessions/${bobSessions[0]!.id}`, alice.cookie)).statusCode).toBe(404);
      expect((await call('GET', '/api/auth/me', bob.cookie)).statusCode).toBe(200);
    });

    it('signs out everywhere else in one step', async () => {
      const a = await login();
      const b = await login();
      const response = await call('DELETE', '/api/auth/sessions', alice.cookie);
      expect(response.json()).toEqual({ signedOutSessions: 2 });
      expect((await call('GET', '/api/auth/me', a.cookie)).statusCode).toBe(401);
      expect((await call('GET', '/api/auth/me', b.cookie)).statusCode).toBe(401);
      expect((await call('GET', '/api/auth/me', alice.cookie)).statusCode).toBe(200);
    });

    it('treats ending the current session as signing out', async () => {
      const sessions = (await call('GET', '/api/auth/sessions', alice.cookie)).json().sessions as Array<{
        id: string;
        current: boolean;
      }>;
      const response = await call('DELETE', `/api/auth/sessions/${sessions.find((s) => s.current)!.id}`, alice.cookie);
      expect(response.statusCode).toBe(204);
      expect(String(response.headers['set-cookie'])).toContain('fs_session=;');
      expect((await call('GET', '/api/auth/me', alice.cookie)).statusCode).toBe(401);
    });

    it('updates "last active" at most every five minutes', async () => {
      const read = async () =>
        (await h.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM sessions'))[0]!.last_seen_at.getTime();
      const start = await read();

      h.clock.advanceHours(1 / 60);
      await call('GET', '/api/auth/me', alice.cookie);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await read()).toBe(start);

      h.clock.advanceHours(10 / 60);
      await call('GET', '/api/auth/me', alice.cookie);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await read()).toBe(h.clock.now().getTime());
    });
  });

  describe('invitation email', () => {
    it('emails the invitation link, with user-supplied names escaped', async () => {
      await call('PATCH', `/api/workspaces/${alice.workspaceId}`, alice.cookie, {
        name: '<img src=x onerror=alert(1)>',
      });
      const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'bob@example.com',
        role: 'VIEWER',
      });
      expect(invite.statusCode).toBe(201);

      const message = await h.mailer.waitFor((m) => m.to === 'bob@example.com');
      expect(message.text).toContain(invite.json().inviteUrl);
      expect(message.text).toContain('as a viewer');
      expect(message.html).not.toContain('<img');
      expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('retries the email when the mail server fails, without losing it', async () => {
      h.mailer.failNext = true;
      const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'bob@example.com',
      });
      expect(invite.statusCode).toBe(201);

      // The first attempt fails and is rescheduled with backoff, not dropped.
      for (let i = 0; i < 40; i++) {
        const [job] = await h.query<{ status: string; attempts: number }>(
          `SELECT status, attempts FROM jobs WHERE queue = 'email.send'`,
        );
        if (job?.attempts === 1 && job.status === 'queued') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const [failedOnce] = await h.query<{ status: string; attempts: number; last_error: string }>(
        `SELECT status, attempts, last_error FROM jobs WHERE queue = 'email.send'`,
      );
      expect(failedOnce).toMatchObject({ status: 'queued', attempts: 1, last_error: 'simulated SMTP failure' });
      expect(h.mailer.sent).toHaveLength(0);

      h.clock.advanceHours(1 / 60);
      await h.mailer.waitFor((m) => m.to === 'bob@example.com');
      const [done] = await h.query<{ status: string }>(`SELECT status FROM jobs WHERE queue = 'email.send'`);
      expect(done!.status).toBe('done');
    });

    it('never sends an email for an invitation that was not saved', async () => {
      const invalid = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'alice@example.com',
      });
      expect(invalid.statusCode).toBe(409);
      await h.runJobs();
      expect(h.mailer.sent).toHaveLength(0);
      expect(await h.query('SELECT 1 FROM jobs')).toHaveLength(0);
    });
  });
});
