import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { folderGrantCookieName } from '../../src/modules/folder-shares/folder-shares.service';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

function unzipNames(buffer: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('no zip'));
      const names: string[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('folder share links', () => {
  let h: Harness;
  let owner: User;
  let member: User;
  let viewer: User;
  let ids: Record<string, string>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (user: User | undefined, method: string, url: string, payload?: object, cookie?: string) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: user ? { cookie: user.cookie } : cookie ? { cookie } : {},
      ...(payload ? { payload } : {}),
    });

  async function join(email: string, role: 'MEMBER' | 'VIEWER'): Promise<User> {
    const user = await registerUser(h.app, email);
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, { email, role });
    await call(user, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
    return user;
  }

  async function folder(name: string, parentId: string | null = null): Promise<string> {
    const res = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name, parentId });
    return res.json().folder.id;
  }

  async function file(name: string, folderId: string | null): Promise<string> {
    const res = await uploadDocument(
      h.app,
      owner.cookie,
      owner.workspaceId,
      name,
      Buffer.from(`body of ${name}`),
      'text/plain',
    );
    const id = res.json().document.id;
    if (folderId) await call(owner, 'PATCH', `/api/documents/${id}`, { folderId });
    return id;
  }

  async function shareFolder(folderId: string, as: User = owner, settings: object = {}) {
    return call(as, 'POST', '/api/folder-shares', { folderId, ...settings });
  }

  const tokenOf = (res: { json(): { share: { url: string } } }) => res.json().share.url.split('/f/')[1]!;
  const pub = (method: string, url: string, cookie?: string) => call(undefined, method, url, undefined, cookie);

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await join('member@example.com', 'MEMBER');
    viewer = await join('viewer@example.com', 'VIEWER');
    // Reports/{a.txt, trashed.txt, pending.txt, Q1/{b.txt, Deep/{c.txt}}}, Other/secret.txt, root.txt
    const reports = await folder('Reports');
    const q1 = await folder('Q1', reports);
    const deep = await folder('Deep', q1);
    const other = await folder('Other');
    ids = {
      reports,
      q1,
      deep,
      other,
      a: await file('a.txt', reports),
      trashed: await file('trashed.txt', reports),
      pending: await file('pending.txt', reports),
      b: await file('b.txt', q1),
      c: await file('c.txt', deep),
      secret: await file('secret.txt', other),
      root: await file('root.txt', null),
    };
    await call(owner, 'DELETE', `/api/documents/${ids.trashed}`);
    await h.query(`UPDATE documents SET scan_status = 'pending' WHERE id = $1`, [ids.pending]);
  });

  it('lets the recipient browse the folder and everything below it, and nothing else', async () => {
    const created = await shareFolder(ids.reports!);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().share.url).toMatch(/\/f\/fsh_[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(created);

    const top = (await pub('GET', `/api/folder-shares/${token}`)).json();
    expect(top).toMatchObject({
      locked: false,
      name: 'Reports',
      passwordProtected: false,
      path: [{ id: ids.reports, name: 'Reports' }],
      folders: [{ id: ids.q1, name: 'Q1', documentCount: 1, folderCount: 1 }],
      truncated: false,
    });
    // Trashed and not-yet-scanned files are not listed.
    expect(top.documents.map((d: { filename: string }) => d.filename)).toEqual(['a.txt']);

    const deep = (await pub('GET', `/api/folder-shares/${token}?folderId=${ids.deep}`)).json();
    expect(deep.path.map((p: { name: string }) => p.name)).toEqual(['Reports', 'Q1', 'Deep']);
    expect(deep.documents.map((d: { filename: string }) => d.filename)).toEqual(['c.txt']);

    for (const outside of [ids.other, '00000000-0000-4000-8000-000000000000']) {
      expect((await pub('GET', `/api/folder-shares/${token}?folderId=${outside}`)).statusCode).toBe(404);
    }
  });

  it('downloads files at any depth inside the folder, and refuses everything outside it', async () => {
    const token = tokenOf(await shareFolder(ids.reports!));
    for (const inside of [ids.a, ids.c]) {
      const res = await pub('GET', `/api/folder-shares/${token}/documents/${inside}/download`);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^https?:\/\//);
    }
    for (const outside of [ids.secret, ids.root, ids.trashed]) {
      expect((await pub('GET', `/api/folder-shares/${token}/documents/${outside}/download`)).statusCode).toBe(404);
    }
    const pending = await pub('GET', `/api/folder-shares/${token}/documents/${ids.pending}/download`);
    expect(pending.statusCode).toBe(409);

    // Moving a file out of the folder takes it out of the link at once.
    await call(owner, 'PATCH', `/api/documents/${ids.a}`, { folderId: ids.other });
    expect((await pub('GET', `/api/folder-shares/${token}/documents/${ids.a}/download`)).statusCode).toBe(404);
  });

  it('zips the folder or any folder inside it, keeping the structure', async () => {
    const token = tokenOf(await shareFolder(ids.reports!));
    const all = await pub('GET', `/api/folder-shares/${token}/archive`);
    expect(all.statusCode).toBe(200);
    expect(all.headers['content-disposition']).toMatch(/^attachment; filename="Reports.zip"/);
    expect(await unzipNames(all.rawPayload)).toEqual(['a.txt', 'Q1/b.txt', 'Q1/Deep/c.txt', 'NOT-INCLUDED.txt']);

    const sub = await pub('GET', `/api/folder-shares/${token}/archive?folderId=${ids.q1}`);
    expect(sub.headers['content-disposition']).toMatch(/filename="Q1.zip"/);
    expect(await unzipNames(sub.rawPayload)).toEqual(['b.txt', 'Deep/c.txt']);

    const summary = (await pub('GET', `/api/folder-shares/${token}/archive/summary`)).json();
    expect(summary).toMatchObject({ filename: 'Reports.zip', files: 3, skipped: 1 });
    expect((await pub('GET', `/api/folder-shares/${token}/archive?folderId=${ids.other}`)).statusCode).toBe(404);
  });

  it('counts opens and downloads for the sender, and tells them the first time it is opened', async () => {
    const created = await shareFolder(ids.reports!, member);
    const token = tokenOf(created);
    await pub('POST', `/api/folder-shares/${token}/view`);
    await pub('GET', `/api/folder-shares/${token}/documents/${ids.a}/download`);
    await pub('GET', `/api/folder-shares/${token}/archive`);

    await expect
      .poll(
        async () =>
          (await call(member, 'GET', `/api/workspaces/${owner.workspaceId}/folders/${ids.reports}/shares`)).json()
            .shares[0],
      )
      .toMatchObject({ opens: 1, downloads: 2, hasPassword: false });
    await expect
      .poll(async () =>
        (await call(member, 'GET', '/api/notifications')).json().notifications.map((n: { title: string }) => n.title),
      )
      .toContain('Your link to the folder Reports was opened');
    const audit = await h.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_type = 'folder_share' ORDER BY seq`,
    );
    expect(audit.map((a) => a.action)[0]).toBe('share.created');
  });

  it('keeps a password-protected folder locked, and locks out guessing', async () => {
    const token = tokenOf(await shareFolder(ids.reports!, owner, { password: 'open-sesame' }));
    expect((await pub('GET', `/api/folder-shares/${token}`)).json()).toEqual({
      locked: true,
      expiresAt: expect.any(String),
    });
    for (const path of [`documents/${ids.a}/download`, 'archive', 'archive/summary']) {
      const res = await pub('GET', `/api/folder-shares/${token}/${path}`);
      expect(res.statusCode, path).toBe(401);
      expect(res.json().error.code).toBe('PASSWORD_REQUIRED');
    }
    expect((await pub('POST', `/api/folder-shares/${token}/view`)).statusCode).toBe(401);

    const wrong = await call(undefined, 'POST', `/api/folder-shares/${token}/unlock`, { password: 'nope-nope' });
    expect(wrong.json().error.code).toBe('WRONG_PASSWORD');
    const right = await call(undefined, 'POST', `/api/folder-shares/${token}/unlock`, { password: 'open-sesame' });
    expect(right.statusCode).toBe(204);
    const cookie = String(right.headers['set-cookie']).split(';')[0]!;
    expect((await pub('GET', `/api/folder-shares/${token}`, cookie)).json().locked).toBe(false);
    expect((await pub('GET', `/api/folder-shares/${token}/documents/${ids.a}/download`, cookie)).statusCode).toBe(302);

    // A grant for one link never opens another.
    const other = tokenOf(await shareFolder(ids.reports!, owner, { password: 'open-sesame' }));
    const moved = `${folderGrantCookieName(other)}=${cookie.split('=').slice(1).join('=')}`;
    expect((await pub('GET', `/api/folder-shares/${other}`, moved)).json().locked).toBe(true);

    for (let i = 0; i < 9; i += 1)
      await call(undefined, 'POST', `/api/folder-shares/${token}/unlock`, { password: 'nope-nope' });
    const locked = await call(undefined, 'POST', `/api/folder-shares/${token}/unlock`, { password: 'open-sesame' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('LINK_LOCKED');
  });

  it('dies when revoked, when it expires, when its folder is deleted, or with its workspace', async () => {
    const revoked = await shareFolder(ids.reports!);
    await call(owner, 'DELETE', `/api/folder-shares/${revoked.json().share.id}`);
    expect((await pub('GET', `/api/folder-shares/${tokenOf(revoked)}`)).statusCode).toBe(410);

    const expiring = tokenOf(await shareFolder(ids.reports!, owner, { expiresInHours: 1 }));
    h.clock.advanceHours(2);
    expect((await pub('GET', `/api/folder-shares/${expiring}`)).statusCode).toBe(410);

    const empty = await folder('Empty');
    const gone = tokenOf(await shareFolder(empty));
    await call(owner, 'DELETE', `/api/workspaces/${owner.workspaceId}/folders/${empty}`);
    expect((await pub('GET', `/api/folder-shares/${gone}`)).statusCode).toBe(404);
    expect((await pub('GET', '/api/folder-shares/fsh_doesnotexistatallxxxxxxxxxxxxxxxxxx')).statusCode).toBe(404);

    const live = tokenOf(await shareFolder(ids.reports!));
    const workspace = await call(owner, 'GET', '/api/auth/me');
    const name = workspace.json().workspaces.find((w: { id: string }) => w.id === owner.workspaceId).name;
    await call(owner, 'DELETE', `/api/workspaces/${owner.workspaceId}`, { confirmName: name });
    expect((await pub('GET', `/api/folder-shares/${live}`)).statusCode).toBe(410);
  });

  it('follows the same rules as document links for who may create and revoke them', async () => {
    expect((await shareFolder(ids.reports!, viewer)).statusCode).toBe(403);
    const outsider = await registerUser(h.app, 'outsider@example.com');
    expect((await shareFolder(ids.reports!, outsider)).statusCode).toBe(404);
    expect(
      (await call(outsider, 'GET', `/api/workspaces/${owner.workspaceId}/folders/${ids.reports}/shares`)).statusCode,
    ).toBe(404);
    // Viewers can see a folder's links, like a document's.
    expect(
      (await call(viewer, 'GET', `/api/workspaces/${owner.workspaceId}/folders/${ids.reports}/shares`)).statusCode,
    ).toBe(200);

    const owners = await shareFolder(ids.reports!);
    expect((await call(member, 'DELETE', `/api/folder-shares/${owners.json().share.id}`)).statusCode).toBe(403);
    const members = await shareFolder(ids.reports!, member);
    expect((await call(owner, 'DELETE', `/api/folder-shares/${members.json().share.id}`)).statusCode).toBe(204);
  });

  it("revokes a person's folder links when they leave the workspace or become a viewer", async () => {
    const byMember = tokenOf(await shareFolder(ids.reports!, member));
    const second = await join('second@example.com', 'MEMBER');
    const bySecond = tokenOf(await shareFolder(ids.reports!, second));

    await call(owner, 'DELETE', `/api/workspaces/${owner.workspaceId}/members/${member.userId}`);
    expect((await pub('GET', `/api/folder-shares/${byMember}`)).statusCode).toBe(410);

    await call(owner, 'PATCH', `/api/workspaces/${owner.workspaceId}/members/${second.userId}`, { role: 'VIEWER' });
    expect((await pub('GET', `/api/folder-shares/${bySecond}`)).statusCode).toBe(410);
  });
});
