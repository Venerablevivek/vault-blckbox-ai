import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;
interface Comment {
  id: string;
  body: string;
  authorEmail: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

describe('comments on documents', () => {
  let h: Harness;
  let owner: User;
  let member: User;
  let viewer: User;
  let outsider: User;
  let documentId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (user: User, method: string, url: string, payload?: unknown) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie: user.cookie }, ...(payload ? { payload } : {}) });
  const comments = async (user: User) =>
    (await call(user, 'GET', `/api/documents/${documentId}/comments`)).json().comments as Comment[];
  const add = (user: User, body: string) => call(user, 'POST', `/api/documents/${documentId}/comments`, { body });

  async function join(user: User, email: string, role: 'MEMBER' | 'VIEWER') {
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, {
      email,
      role,
    });
    await call(user, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
  }

  const notificationsOf = async (user: User) =>
    (await call(user, 'GET', '/api/notifications')).json().notifications as Array<{ type: string; title: string }>;

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await registerUser(h.app, 'member@example.com');
    viewer = await registerUser(h.app, 'viewer@example.com');
    outsider = await registerUser(h.app, 'outsider@example.com');
    await join(member, 'member@example.com', 'MEMBER');
    await join(viewer, 'viewer@example.com', 'VIEWER');
    documentId = (
      await uploadDocument(h.app, owner.cookie, owner.workspaceId, 'plan.pdf', Buffer.from('%PDF-1.4\nplan\n%%EOF\n'))
    ).json().document.id;
  });

  it('every member, viewers included, can read and write the thread, oldest first', async () => {
    expect((await add(member, 'First pass looks good.')).statusCode).toBe(201);
    expect((await add(viewer, 'Can we fix page 2?')).statusCode).toBe(201);
    const thread = await comments(owner);
    expect(thread.map((c) => [c.authorEmail, c.body])).toEqual([
      ['member@example.com', 'First pass looks good.'],
      ['viewer@example.com', 'Can we fix page 2?'],
    ]);
  });

  it('is invisible to people outside the workspace (404, never 403)', async () => {
    await add(member, 'internal');
    expect((await call(outsider, 'GET', `/api/documents/${documentId}/comments`)).statusCode).toBe(404);
    expect((await add(outsider, 'hello')).statusCode).toBe(404);
    const id = (await comments(member))[0]!.id;
    expect((await call(outsider, 'DELETE', `/api/documents/${documentId}/comments/${id}`)).statusCode).toBe(404);
  });

  it('only the author can edit; the author or an owner can delete', async () => {
    const created = (await add(member, 'typo hre')).json().comment as Comment;
    expect(created.canEdit).toBe(true);
    expect(created.canDelete).toBe(true);

    const url = `/api/documents/${documentId}/comments/${created.id}`;
    expect((await call(viewer, 'PATCH', url, { body: 'hijack' })).statusCode).toBe(403);
    expect((await call(owner, 'PATCH', url, { body: 'hijack' })).statusCode).toBe(403);
    const edited = await call(member, 'PATCH', url, { body: 'typo here' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().comment.body).toBe('typo here');
    expect(edited.json().comment.editedAt).not.toBeNull();

    const seenByViewer = (await comments(viewer))[0]!;
    expect([seenByViewer.canEdit, seenByViewer.canDelete]).toEqual([false, false]);
    const seenByOwner = (await comments(owner))[0]!;
    expect([seenByOwner.canEdit, seenByOwner.canDelete]).toEqual([false, true]);

    expect((await call(viewer, 'DELETE', url)).statusCode).toBe(403);
    expect((await call(owner, 'DELETE', url)).statusCode).toBe(204);
    expect(await comments(member)).toEqual([]);
    expect((await call(member, 'DELETE', url)).statusCode).toBe(404);
  });

  it('rejects empty and oversized comments, and strips control characters', async () => {
    expect((await add(member, '   ')).statusCode).toBe(400);
    expect((await add(member, 'x'.repeat(2001))).statusCode).toBe(400);
    const bell = String.fromCharCode(7);
    const created = await add(member, `  line one${bell}\nline two  `);
    expect(created.statusCode).toBe(201);
    expect(created.json().comment.body).toBe('line one\nline two');
  });

  it('notifies the uploader and everyone in the thread, never the author', async () => {
    await add(member, 'one');
    await expect
      .poll(async () => (await notificationsOf(owner)).filter((n) => n.type === 'document.commented').length)
      .toBe(1);
    await add(viewer, 'two');
    await expect
      .poll(async () => (await notificationsOf(member)).filter((n) => n.type === 'document.commented').length)
      .toBe(1);
    await expect
      .poll(async () => (await notificationsOf(owner)).filter((n) => n.type === 'document.commented').length)
      .toBe(2);
    expect((await notificationsOf(viewer)).some((n) => n.type === 'document.commented')).toBe(false);
    const titles = (await notificationsOf(owner)).map((n) => n.title);
    expect(titles).toContain('viewer@example.com commented on plan.pdf');
  });

  it('records adding and deleting in the audit trail', async () => {
    const id = (await add(member, 'audit me')).json().comment.id as string;
    await call(member, 'DELETE', `/api/documents/${documentId}/comments/${id}`);
    const events = (await call(owner, 'GET', `/api/workspaces/${owner.workspaceId}/audit?resourceId=${documentId}`))
      .json()
      .events.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(['document.comment_added', 'document.comment_deleted']));
  });

  it('goes away with its document', async () => {
    await add(member, 'bye');
    await call(owner, 'DELETE', `/api/documents/${documentId}`);
    expect((await call(member, 'GET', `/api/documents/${documentId}/comments`)).statusCode).toBe(404);
  });
});
