import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, sendToFileRequest, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('file requests', () => {
  let h: Harness;
  let owner: User;
  let member: User;
  let viewer: User;
  let outsider: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (user: User | null, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: user ? { cookie: user.cookie } : {},
      ...(payload ? { payload } : {}),
    });

  async function join(user: User, email: string, role: 'MEMBER' | 'VIEWER') {
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, { email, role });
    await call(user, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
  }

  async function createRequest(user: User, body: Record<string, unknown> = {}) {
    const res = await call(user, 'POST', `/api/workspaces/${owner.workspaceId}/file-requests`, {
      title: 'Send your ID scan',
      ...body,
    });
    expect(res.statusCode).toBe(201);
    return {
      id: res.json().request.id as string,
      token: String(res.json().url).split('/r/')[1]!,
      json: res.json(),
    };
  }

  const documentsOf = async (user: User, query = '') =>
    (await call(user, 'GET', `/api/workspaces/${owner.workspaceId}/documents?${query}`)).json();

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await registerUser(h.app, 'member@example.com');
    viewer = await registerUser(h.app, 'viewer@example.com');
    outsider = await registerUser(h.app, 'outsider@example.com');
    await join(member, 'member@example.com', 'MEMBER');
    await join(viewer, 'viewer@example.com', 'VIEWER');
  });

  it('lets someone without an account send a file into the chosen folder', async () => {
    const folder = (
      await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'Incoming' })
    ).json().folder;
    const request = await createRequest(member, { folderId: folder.id, message: 'PDF please', maxFiles: 5 });
    expect(request.json.url).toMatch(/\/r\/frq_[A-Za-z0-9_-]{43}$/);
    expect(request.json.request).toMatchObject({ status: 'open', folderName: 'Incoming', receivedCount: 0 });

    const info = await call(null, 'GET', `/api/requests/${request.token}`);
    expect(info.statusCode).toBe(200);
    expect(info.json().request).toMatchObject({
      title: 'Send your ID scan',
      message: 'PDF please',
      requestedBy: 'member@example.com',
      remainingFiles: 5,
    });

    const sent = await sendToFileRequest(h.app, request.token, {
      name: 'Dana Client',
      email: 'dana@client.test',
      filename: 'id-scan.pdf',
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ file: { filename: 'id-scan.pdf' }, remainingFiles: 4 });

    const listed = await documentsOf(owner, `folderId=${folder.id}`);
    expect(listed.documents.map((d: { filename: string }) => d.filename)).toEqual(['id-scan.pdf']);
    // Owned by the person who asked for it: they can manage what they asked for.
    expect(listed.documents[0].uploadedBy).toBe(member.userId);

    const files = (await call(member, 'GET', `/api/file-requests/${request.id}/files`)).json().files;
    expect(files).toEqual([
      expect.objectContaining({ senderName: 'Dana Client', senderEmail: 'dana@client.test', filename: 'id-scan.pdf' }),
    ]);
  });

  it('applies the same checks as any upload: type against the bytes, and an empty file', async () => {
    const { token } = await createRequest(owner);
    const disguised = await sendToFileRequest(h.app, token, {
      name: 'Mallory',
      filename: 'invoice.pdf',
      body: Buffer.from('MZ\x90\x00 this is really a program'),
    });
    expect(disguised.statusCode).toBe(415);
    const empty = await sendToFileRequest(h.app, token, { name: 'Mallory', body: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
    expect((await documentsOf(owner)).documents).toEqual([]);
  });

  it('requires a name, and a valid email when one is given', async () => {
    const { token } = await createRequest(owner);
    expect((await sendToFileRequest(h.app, token, {})).statusCode).toBe(400);
    expect((await sendToFileRequest(h.app, token, { name: 'Dana', email: 'not-an-email' })).statusCode).toBe(400);
    expect((await sendToFileRequest(h.app, token, { name: 'Dana', email: '' })).statusCode).toBe(201);
  });

  it('stops at its file limit, even when two uploads race for the last slot', async () => {
    const { token, id } = await createRequest(owner, { maxFiles: 2 });
    expect((await sendToFileRequest(h.app, token, { name: 'First', filename: 'f1.pdf' })).statusCode).toBe(201);
    const racing = await Promise.all(
      [2, 3].map((n) => sendToFileRequest(h.app, token, { name: `Sender ${n}`, filename: `f${n}.pdf` })),
    );
    expect(racing.map((r) => r.statusCode).sort()).toEqual([201, 410]);
    expect((await documentsOf(owner)).documents).toHaveLength(2);
    expect((await call(null, 'GET', `/api/requests/${token}`)).statusCode).toBe(410);
    const summary = (await call(owner, 'GET', `/api/workspaces/${owner.workspaceId}/file-requests`)).json().requests;
    expect(summary.find((r: { id: string }) => r.id === id)).toMatchObject({ status: 'full', receivedCount: 2 });
  });

  it('expires, and closing it keeps what arrived', async () => {
    const expiring = await createRequest(owner, { expiresInDays: 1 });
    h.clock.advanceHours(25);
    expect((await call(null, 'GET', `/api/requests/${expiring.token}`)).statusCode).toBe(410);
    expect((await sendToFileRequest(h.app, expiring.token, { name: 'Late' })).statusCode).toBe(410);

    const closing = await createRequest(owner);
    expect((await sendToFileRequest(h.app, closing.token, { name: 'Early' })).statusCode).toBe(201);
    expect((await call(owner, 'DELETE', `/api/file-requests/${closing.id}`)).statusCode).toBe(204);
    expect((await sendToFileRequest(h.app, closing.token, { name: 'Too late' })).statusCode).toBe(410);
    expect((await documentsOf(owner)).documents).toHaveLength(1);
    expect((await call(null, 'GET', '/api/requests/frq_doesnotexist_doesnotexist')).statusCode).toBe(404);
  });

  it('follows the permission model: viewers and outsiders cannot make or see requests', async () => {
    expect(
      (await call(viewer, 'POST', `/api/workspaces/${owner.workspaceId}/file-requests`, { title: 'x' })).statusCode,
    ).toBe(403);
    expect((await call(viewer, 'GET', `/api/workspaces/${owner.workspaceId}/file-requests`)).statusCode).toBe(403);
    expect(
      (await call(outsider, 'POST', `/api/workspaces/${owner.workspaceId}/file-requests`, { title: 'x' })).statusCode,
    ).toBe(404);

    const mine = await createRequest(member);
    expect((await call(outsider, 'GET', `/api/file-requests/${mine.id}/files`)).statusCode).toBe(404);
    expect((await call(outsider, 'DELETE', `/api/file-requests/${mine.id}`)).statusCode).toBe(404);

    const owners = await createRequest(owner);
    // A member can see the owner's request but not close it; an owner can close anyone's.
    const seen = (await call(member, 'GET', `/api/workspaces/${owner.workspaceId}/file-requests`)).json().requests;
    expect(seen.find((r: { id: string }) => r.id === owners.id).canManage).toBe(false);
    expect((await call(member, 'DELETE', `/api/file-requests/${owners.id}`)).statusCode).toBe(403);
    expect((await call(owner, 'DELETE', `/api/file-requests/${mine.id}`)).statusCode).toBe(204);
  });

  it('closes when its maker is made a viewer', async () => {
    const request = await createRequest(member);
    expect(
      (await call(owner, 'PATCH', `/api/workspaces/${owner.workspaceId}/members/${member.userId}`, { role: 'VIEWER' }))
        .statusCode,
    ).toBe(204);
    expect((await sendToFileRequest(h.app, request.token, { name: 'Dana' })).statusCode).toBe(410);
  });

  it('notifies its maker, and audits the upload without a member as the actor', async () => {
    const request = await createRequest(member);
    await sendToFileRequest(h.app, request.token, { name: 'Dana Client', filename: 'contract.pdf' });
    await expect
      .poll(async () =>
        (
          (await call(member, 'GET', '/api/notifications')).json().notifications as Array<{
            type: string;
            title: string;
          }>
        )
          .filter((n) => n.type === 'file_request.received')
          .map((n) => n.title),
      )
      .toEqual(['Dana Client sent contract.pdf']);

    const events = (await call(owner, 'GET', `/api/workspaces/${owner.workspaceId}/audit`)).json().events as Array<{
      action: string;
      actorEmail: string | null;
      metadata: Record<string, unknown>;
    }>;
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['file_request.created', 'document.uploaded']));
    const upload = events.find((e) => e.action === 'document.uploaded')!;
    expect(upload.actorEmail).toBeNull();
    expect(upload.metadata).toMatchObject({ via: 'file_request', request: 'Send your ID scan', sender: 'Dana Client' });
  });
});
