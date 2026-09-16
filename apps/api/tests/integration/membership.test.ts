import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, TEST_PASSWORD, type Harness } from '../helpers/harness';

/**
 * Blueprint test area 4: "Duplicate membership is prevented; invitation acceptance
 * creates one membership."
 */
describe('membership and invitations', () => {
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

  async function invite(email: string): Promise<string> {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: alice.cookie },
      payload: { email, role: 'MEMBER' },
    });
    expect(response.statusCode).toBe(201);
    // No mail provider is configured, so the link comes back in the response.
    return response.json().inviteUrl.split('/invite/')[1];
  }

  it('creates exactly one membership when an existing user accepts', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
    const token = await invite('bob@example.com');

    const accept = await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });
    expect(accept.statusCode).toBe(200);

    const rows = await h.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [alice.workspaceId, bob.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('cannot be accepted twice', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
    const token = await invite('bob@example.com');

    await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });
    const second = await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });

    expect(second.statusCode).toBe(410);
    const rows = await h.query('SELECT 1 FROM workspace_members WHERE workspace_id = $1', [
      alice.workspaceId,
    ]);
    expect(rows).toHaveLength(2); // alice + bob, not three
  });

  it('cannot be redeemed by a different account (forwarded link)', async () => {
    const token = await invite('bob@example.com');
    const mallory = await registerUser(h.app, 'mallory@example.com');

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: mallory.cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INVITE_EMAIL_MISMATCH');
    // The invitation is still pending for its real recipient.
    const rows = await h.query('SELECT accepted_at FROM invitations');
    expect(rows[0]!.accepted_at).toBeNull();
  });

  it('lets someone without an account register and join in one step', async () => {
    const token = await invite('carol@example.com');

    const register = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'carol@example.com', password: TEST_PASSWORD, inviteToken: token },
    });
    expect(register.statusCode).toBe(201);

    const cookie = String(register.headers['set-cookie']).split(';')[0]!;
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    // Their own workspace plus the one they were invited to.
    const workspaceIds = me.json().workspaces.map((w: { id: string }) => w.id);
    expect(workspaceIds).toContain(alice.workspaceId);
    expect(workspaceIds).toHaveLength(2);
  });

  it('rejects an expired invitation', async () => {
    await registerUser(h.app, 'bob@example.com');
    const token = await invite('bob@example.com');

    h.clock.advanceHours(h.config.INVITE_TTL_HOURS + 1);

    // The invite TTL and the session TTL are both 7 days, so Bob's original session has
    // expired too. Sign in again so this test asserts the invitation rule and not the
    // session rule (session expiry has its own test in auth.test.ts).
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'bob@example.com', password: TEST_PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    expect((await h.app.inject({ method: 'GET', url: `/api/invitations/${token}` })).statusCode).toBe(410);
    const accept = await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie },
    });
    expect(accept.statusCode).toBe(410);
  });

  it('replaces a pending invitation instead of duplicating it', async () => {
    await invite('bob@example.com');
    await invite('bob@example.com');
    const rows = await h.query('SELECT 1 FROM invitations WHERE accepted_at IS NULL');
    expect(rows).toHaveLength(1);
  });

  it('refuses to invite someone who is already a member', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
    const token = await invite('bob@example.com');
    await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });

    const again = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: alice.cookie },
      payload: { email: 'bob@example.com' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_MEMBER');
  });

  it('gives every new account its own workspace, owned by them', async () => {
    const rows = await h.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE user_id = $1',
      [alice.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('OWNER');
  });

  it('rejects a duplicate email at registration', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ALICE@example.com', password: TEST_PASSWORD },
    });
    // Emails are normalised, so a different case is the same account.
    expect(response.statusCode).toBe(409);
  });
});
