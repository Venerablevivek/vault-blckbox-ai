import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('notification preferences and digests', () => {
  let h: Harness;
  let owner: User;
  let member: User;
  let other: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (user: User | undefined, method: string, url: string, payload?: object) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: user ? { cookie: user.cookie } : {},
      ...(payload ? { payload } : {}),
    });

  async function join(email: string): Promise<User> {
    const user = await registerUser(h.app, email);
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, { email });
    await call(user, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
    return user;
  }

  const setPreferences = (user: User, preferences: object) =>
    call(user, 'PUT', '/api/notifications/preferences', { digest: 'off', instant: [], muted: [], ...preferences });
  const inbox = async (user: User) =>
    (
      (await call(user, 'GET', '/api/notifications')).json().notifications as Array<{ type: string; title: string }>
    ).map((n) => n.title);
  const upload = async (as: User, name: string) => {
    await uploadDocument(h.app, as.cookie, owner.workspaceId, name);
    await h.drainJobs();
  };

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await join('member@example.com');
    other = await join('other@example.com');
    await h.drainJobs();
    h.mailer.clear();
    await h.query('DELETE FROM notifications');
  });

  it('starts with everything in the app and nothing by email', async () => {
    const res = await call(owner, 'GET', '/api/notifications/preferences');
    expect(res.json()).toEqual({
      digest: 'off',
      instant: [],
      muted: [],
      essential: [
        'share.forwarding_suspected',
        'member.removed',
        'member.role_changed',
        'workspace.deleted',
        'document.quarantined',
      ],
    });
  });

  it('stops showing a muted type, for that person only, and never mutes essential ones', async () => {
    expect((await setPreferences(owner, { muted: ['document.uploaded', 'document.uploaded'] })).json().muted).toEqual([
      'document.uploaded',
    ]);
    await upload(member, 'plan.pdf');
    expect(await inbox(owner)).toEqual([]);
    expect(await inbox(other)).toEqual(['plan.pdf was added']);

    const essential = await setPreferences(owner, { muted: ['member.removed'] });
    expect(essential.statusCode).toBe(400);
    expect(essential.json().error.code).toBe('ESSENTIAL_NOTIFICATION');
    expect((await setPreferences(owner, { muted: ['document.exploded'] })).statusCode).toBe(400);
  });

  it('emails chosen types as they happen, to verified addresses only', async () => {
    await setPreferences(owner, { instant: ['document.uploaded'] });
    await setPreferences(other, { instant: ['document.uploaded'] });
    await h.query(`UPDATE users SET email_verified_at = NULL WHERE email = 'other@example.com'`);

    await upload(member, 'budget.pdf');
    const mail = await h.mailer.waitFor((m) => m.to === 'owner@example.com');
    expect(mail.subject).toBe('budget.pdf was added');
    expect(mail.text).toContain(`/workspaces/${owner.workspaceId}`);
    await h.drainJobs();
    expect(h.mailer.sent.map((m) => m.to)).toEqual(['owner@example.com']);
    // Other still sees it in the app.
    expect(await inbox(other)).toEqual(['budget.pdf was added']);
  });

  it('can email a type without showing it in the app', async () => {
    await setPreferences(owner, { instant: ['document.uploaded'], muted: ['document.uploaded'] });
    await upload(member, 'quiet.pdf');
    expect((await h.mailer.waitFor((m) => m.to === 'owner@example.com')).subject).toBe('quiet.pdf was added');
    expect(await inbox(owner)).toEqual([]);
  });

  it('emails a direct notification too, such as the first open of a link', async () => {
    await setPreferences(owner, { instant: ['share.first_open'] });
    const doc = (await uploadDocument(h.app, owner.cookie, owner.workspaceId, 'deck.pdf')).json().document.id;
    const share = await call(owner, 'POST', '/api/shares', { documentId: doc });
    await call(undefined, 'POST', `/api/shares/${share.json().share.url.split('/s/')[1]}/view`);
    const mail = await h.mailer.waitFor((m) => m.to === 'owner@example.com' && m.subject.includes('was opened'));
    expect(mail.subject).toBe('Your link to deck.pdf was opened');
  });

  it('sends a daily digest of what is unread and new, once a day, and nothing when there is nothing', async () => {
    await setPreferences(owner, { digest: 'daily' });
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) await upload(member, name);

    await h.app.maintenance.runOnce();
    await h.drainJobs();
    const digest = await h.mailer.waitFor((m) => m.to === 'owner@example.com');
    expect(digest.subject).toBe('Vault: 3 unread notifications today');
    expect(digest.text).toContain('- c.pdf was added (My Workspace)');

    // Not again the same day.
    h.mailer.clear();
    await upload(member, 'd.pdf');
    await h.app.maintenance.runOnce();
    await h.drainJobs();
    expect(h.mailer.sent).toEqual([]);

    // The next day: only what arrived since the last digest.
    h.clock.advanceHours(25);
    await h.app.maintenance.runOnce();
    await h.drainJobs();
    const next = await h.mailer.waitFor((m) => m.to === 'owner@example.com');
    expect(next.subject).toBe('Vault: 1 unread notification today');

    // Everything read: nothing to send.
    h.mailer.clear();
    await upload(member, 'e.pdf');
    await call(owner, 'POST', '/api/notifications/read', {});
    h.clock.advanceHours(25);
    await h.app.maintenance.runOnce();
    await h.drainJobs();
    expect(h.mailer.sent).toEqual([]);
  });

  it('waits a week between weekly digests', async () => {
    await setPreferences(owner, { digest: 'weekly' });
    await upload(member, 'a.pdf');
    await h.app.maintenance.runOnce();
    await h.drainJobs();
    expect((await h.mailer.waitFor((m) => m.to === 'owner@example.com')).subject).toBe(
      'Vault: 1 unread notification this week',
    );
    h.mailer.clear();
    await upload(member, 'b.pdf');
    h.clock.advanceHours(24 * 3);
    await h.app.maintenance.runOnce();
    await h.drainJobs();
    expect(h.mailer.sent).toEqual([]);
    h.clock.advanceHours(24 * 5);
    await h.app.maintenance.runOnce();
    await h.drainJobs();
    expect(h.mailer.sent.map((m) => m.to)).toEqual(['owner@example.com']);
  });
});
