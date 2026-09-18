import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, TEST_PASSWORD, uploadDocument, type Harness } from '../helpers/harness';

/** With EMAIL_VERIFICATION=required (the default outside tests). */
describe('email verification', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ env: { EMAIL_VERIFICATION: 'required' } });
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.truncate());

  const call = (method: string, url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function tokenFor(email: string, count = 1): Promise<string> {
    await h.drainJobs();
    const messages = h.mailer.sent.filter((m) => m.to === email && m.subject.startsWith('Confirm'));
    expect(messages.length).toBeGreaterThanOrEqual(count);
    return /verify-email#token=(evt_[\w-]+)/.exec(messages[messages.length - 1]!.text)![1]!;
  }

  it('starts unverified, emails a confirmation link, and confirms with it', async () => {
    const alice = await registerUser(h.app, 'alice@example.com');
    expect((await call('GET', '/api/auth/me', alice.cookie)).json().user.emailVerified).toBe(false);

    const token = await tokenFor('alice@example.com');
    expect((await call('POST', '/api/auth/email/verify', undefined, { token })).statusCode).toBe(204);
    expect((await call('GET', '/api/auth/me', alice.cookie)).json().user.emailVerified).toBe(true);

    const reused = await call('POST', '/api/auth/email/verify', undefined, { token });
    expect(reused.statusCode).toBe(410);
    expect(reused.json().error.code).toBe('VERIFICATION_LINK_INVALID');
  });

  it("can upload, but can't create share links or invite anyone until verified", async () => {
    const alice = await registerUser(h.app, 'alice@example.com');
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    expect(upload.statusCode).toBe(201);

    const share = await call('POST', '/api/shares', alice.cookie, { documentId: upload.json().document.id });
    expect(share.statusCode).toBe(403);
    expect(share.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
      email: 'bob@example.com',
    });
    expect(invite.json().error.code).toBe('EMAIL_NOT_VERIFIED');

    await call('POST', '/api/auth/email/verify', undefined, { token: await tokenFor('alice@example.com') });
    expect(
      (await call('POST', '/api/shares', alice.cookie, { documentId: upload.json().document.id })).statusCode,
    ).toBe(201);
  });

  it('treats joining through an emailed invitation as verification', async () => {
    const alice = await registerUser(h.app, 'alice@example.com');
    await call('POST', '/api/auth/email/verify', undefined, { token: await tokenFor('alice@example.com') });
    const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
      email: 'bob@example.com',
    });
    const inviteToken = invite.json().inviteUrl.split('/invite/')[1];

    const register = await call('POST', '/api/auth/register', undefined, {
      email: 'bob@example.com',
      password: TEST_PASSWORD,
      inviteToken,
    });
    expect(register.json().user.emailVerified).toBe(true);
    await h.drainJobs();
    expect(h.mailer.sent.filter((m) => m.to === 'bob@example.com' && m.subject.startsWith('Confirm'))).toHaveLength(0);
  });

  it('treats a password reset as verification', async () => {
    await registerUser(h.app, 'carol@example.com');
    await call('POST', '/api/auth/password/forgot', undefined, { email: 'carol@example.com' });
    const mail = await h.mailer.waitFor((m) => m.to === 'carol@example.com' && m.subject.includes('Reset'));
    const token = /token=(pwr_[\w-]+)/.exec(mail.text)![1]!;
    const reset = await call('POST', '/api/auth/password/reset', undefined, { token, password: 'a-new-password' });
    expect(reset.json().user.emailVerified).toBe(true);
  });

  it('limits resends, and refuses them once verified', async () => {
    const alice = await registerUser(h.app, 'alice@example.com');
    expect((await call('POST', '/api/auth/email/resend', alice.cookie)).statusCode).toBe(202);
    expect((await call('POST', '/api/auth/email/resend', alice.cookie)).statusCode).toBe(202);
    const limited = await call('POST', '/api/auth/email/resend', alice.cookie);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_EMAILS');

    await call('POST', '/api/auth/email/verify', undefined, { token: await tokenFor('alice@example.com', 3) });
    expect((await call('POST', '/api/auth/email/resend', alice.cookie)).json().error.code).toBe('ALREADY_VERIFIED');
  });

  it('expires verification links', async () => {
    await registerUser(h.app, 'dan@example.com');
    const token = await tokenFor('dan@example.com');
    h.clock.advanceHours(49);
    expect((await call('POST', '/api/auth/email/verify', undefined, { token })).statusCode).toBe(410);
  });
});
