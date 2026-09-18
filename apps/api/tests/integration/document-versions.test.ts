import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { documentsRepo } from '../../src/modules/documents/documents.repo';
import { createHarness, registerUser, SAMPLE_PDF, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('document versions', () => {
  let h: Harness;
  let owner: User;
  let member: User;
  let viewer: User;

  beforeAll(async () => {
    h = await createHarness({ env: { DOCUMENT_MAX_VERSIONS: '3' } });
  });
  afterAll(async () => h.close());

  const call = (user: User | undefined, method: string, url: string, payload?: object) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: user ? { cookie: user.cookie } : {},
      ...(payload ? { payload } : {}),
    });

  async function join(email: string, role: 'MEMBER' | 'VIEWER'): Promise<User> {
    const user = await registerUser(h.app, email);
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, { email, role });
    await call(user, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
    return user;
  }

  /** Uploads `text` as a new version of a document, through the multipart route. */
  function uploadVersion(user: User, documentId: string, text: string | Buffer, type = 'text/plain') {
    const boundary = '----versions';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="new.txt"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      Buffer.isBuffer(text) ? text : Buffer.from(text),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return h.app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }

  async function newDocument(text: string, as: User = owner): Promise<string> {
    const res = await uploadDocument(h.app, as.cookie, owner.workspaceId, 'notes.txt', Buffer.from(text), 'text/plain');
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document.id;
  }

  /** Follows a download redirect and returns the bytes storage serves. */
  async function contentAt(url: string, as: User = owner): Promise<string> {
    const res = await call(as, 'GET', url);
    expect(res.statusCode, res.body).toBe(302);
    return (await fetch(String(res.headers.location))).text();
  }

  const used = async () =>
    Number(
      (
        await h.query<{ storage_used_bytes: string }>('SELECT storage_used_bytes FROM workspaces WHERE id = $1', [
          owner.workspaceId,
        ])
      )[0]!.storage_used_bytes,
    );
  const keys = async (id: string) =>
    (
      await h.query<{ storage_key: string }>(
        `SELECT storage_key FROM documents WHERE id = $1 UNION ALL SELECT storage_key FROM document_versions WHERE document_id = $1`,
        [id],
      )
    ).map((r) => r.storage_key);

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await join('member@example.com', 'MEMBER');
    viewer = await join('viewer@example.com', 'VIEWER');
  });

  it('keeps every version, serves the current one everywhere, and counts them all against the quota', async () => {
    const id = await newDocument('first draft');
    const share = await call(owner, 'POST', '/api/shares', { documentId: id });
    const token = share.json().share.url.split('/s/')[1];

    const v2 = await uploadVersion(owner, id, 'second draft, longer');
    expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json().document).toMatchObject({ id, version: 2, size: 20, filename: 'notes.txt' });

    const versions = (await call(viewer, 'GET', `/api/documents/${id}/versions`)).json().versions;
    expect(
      versions.map((v: { version: number; current: boolean; size: number }) => [v.version, v.current, v.size]),
    ).toEqual([
      [2, true, 20],
      [1, false, 11],
    ]);
    expect(versions[0].uploadedByEmail).toBe('owner@example.com');

    expect(await contentAt(`/api/documents/${id}/download`)).toBe('second draft, longer');
    expect(await contentAt(`/api/documents/${id}/versions/1/download`, viewer)).toBe('first draft');
    expect(await contentAt(`/api/documents/${id}/versions/2/download`)).toBe('second draft, longer');
    // An existing share link now hands out the new version.
    expect(await contentAt(`/api/shares/${token}/download`)).toBe('second draft, longer');
    expect(await used()).toBe(31);

    const listed = (await call(owner, 'GET', `/api/workspaces/${owner.workspaceId}/documents`)).json().documents;
    expect(listed[0]).toMatchObject({ id, version: 2 });
  });

  it('restores an earlier version as a new one, leaving the history as it was', async () => {
    const id = await newDocument('one');
    await uploadVersion(owner, id, 'two!');
    const restored = await call(owner, 'POST', `/api/documents/${id}/versions/1/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().document.version).toBe(3);
    expect(await contentAt(`/api/documents/${id}/download`)).toBe('one');

    const versions = (await call(owner, 'GET', `/api/documents/${id}/versions`)).json().versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    // Each version has its own object.
    const objectKeys = await keys(id);
    expect(new Set(objectKeys).size).toBe(3);
    expect(await used()).toBe(3 + 4 + 3);

    expect((await call(owner, 'POST', `/api/documents/${id}/versions/3/restore`)).json().error.code).toBe(
      'ALREADY_CURRENT',
    );
    expect((await call(owner, 'POST', `/api/documents/${id}/versions/9/restore`)).statusCode).toBe(404);
  });

  it('deletes an earlier version with its object and bytes, but never the current one', async () => {
    const id = await newDocument('one');
    await uploadVersion(owner, id, 'two!');
    const [v1key] = (await h.query<{ storage_key: string }>('SELECT storage_key FROM document_versions')).map(
      (r) => r.storage_key,
    );
    expect((await call(owner, 'DELETE', `/api/documents/${id}/versions/1`)).statusCode).toBe(204);
    expect(await h.objectExists(v1key!)).toBe(false);
    expect(await used()).toBe(4);
    const current = await call(owner, 'DELETE', `/api/documents/${id}/versions/2`);
    expect(current.statusCode).toBe(409);
    expect(current.json().error.code).toBe('CURRENT_VERSION');
  });

  it('keeps only the newest versions, removing the oldest objects and bytes', async () => {
    const id = await newDocument('v1');
    for (const text of ['v2', 'v3', 'v4', 'v5']) expect((await uploadVersion(owner, id, text)).statusCode).toBe(201);
    const versions = (await call(owner, 'GET', `/api/documents/${id}/versions`)).json().versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([5, 4, 3, 2]);
    expect((await keys(id)).length).toBe(4);
    expect(await used()).toBe(8);
    const all = await h.query<{ n: string }>('SELECT COUNT(*) AS n FROM document_versions');
    expect(Number(all[0]!.n)).toBe(3);
  });

  it('refuses a different type, identical content, an empty file, and people who may not change it', async () => {
    const id = await newDocument('hello');
    const wrongType = await uploadVersion(owner, id, SAMPLE_PDF, 'application/pdf');
    expect(wrongType.statusCode).toBe(415);
    const same = await uploadVersion(owner, id, 'hello');
    expect(same.json().error.code).toBe('VERSION_UNCHANGED');
    expect((await uploadVersion(owner, id, '')).statusCode).toBe(400);

    expect((await uploadVersion(member, id, 'members cannot change the owner’s file')).statusCode).toBe(403);
    expect((await uploadVersion(viewer, id, 'viewers cannot either')).statusCode).toBe(403);
    const outsider = await registerUser(h.app, 'outsider@example.com');
    expect((await uploadVersion(outsider, id, 'nor outsiders')).statusCode).toBe(404);
    expect((await call(outsider, 'GET', `/api/documents/${id}/versions`)).statusCode).toBe(404);
    expect((await call(member, 'POST', `/api/documents/${id}/versions/1/restore`)).statusCode).toBe(403);

    // A member can version their own documents.
    const mine = await newDocument('member doc', member);
    expect((await uploadVersion(member, mine, 'member doc, v2')).statusCode).toBe(201);

    await call(owner, 'DELETE', `/api/documents/${id}`);
    expect((await uploadVersion(owner, id, 'trashed')).statusCode).toBe(404);
  });

  it('waits for the current version to be scanned, and never lets an old scan vouch for new content', async () => {
    const id = await newDocument('scan me');
    const [before] = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [id]);
    await h.query(`UPDATE documents SET scan_status = 'pending' WHERE id = $1`, [id]);
    expect((await uploadVersion(owner, id, 'too soon')).json().error.code).toBe('SCAN_PENDING');

    await h.query(`UPDATE documents SET scan_status = 'clean' WHERE id = $1`, [id]);
    await uploadVersion(owner, id, 'newer content');
    await h.query(`UPDATE documents SET scan_status = 'pending' WHERE id = $1`, [id]);
    // A result for the object that was current before must not land on the new one.
    expect(await documentsRepo.setScanResult(h.pool, id, before!.storage_key, 'clean', null, new Date())).toBe(false);
    const [after] = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [id]);
    expect(await documentsRepo.setScanResult(h.pool, id, after!.storage_key, 'clean', null, new Date())).toBe(true);
  });

  it('removes every version when the document is deleted for good, by hand or when the trash expires', async () => {
    const byHand = await newDocument('a');
    await uploadVersion(owner, byHand, 'aa');
    const handKeys = await keys(byHand);
    await call(owner, 'DELETE', `/api/documents/${byHand}`);
    expect((await call(owner, 'DELETE', `/api/documents/${byHand}/permanent`)).statusCode).toBe(204);
    for (const key of handKeys) expect(await h.objectExists(key)).toBe(false);

    const expiring = await newDocument('b');
    await uploadVersion(owner, expiring, 'bb');
    const expiringKeys = await keys(expiring);
    await call(owner, 'DELETE', `/api/documents/${expiring}`);
    h.clock.advanceHours(31 * 24);
    await h.app.maintenance.runOnce();
    for (const key of expiringKeys) expect(await h.objectExists(key)).toBe(false);
    expect(await used()).toBe(0);
    expect(await h.query('SELECT 1 FROM document_versions')).toHaveLength(0);
  });

  it('removes every version when the workspace is deleted', async () => {
    const id = await newDocument('c');
    await uploadVersion(owner, id, 'cc');
    const objectKeys = await keys(id);
    await call(owner, 'DELETE', `/api/workspaces/${owner.workspaceId}`, { confirmName: 'My Workspace' });
    await h.app.maintenance.runOnce();
    for (const key of objectKeys) expect(await h.objectExists(key)).toBe(false);
  });

  it('gives a quarantined file’s bytes back once, not again when it is deleted', async () => {
    const other = await newDocument('stays');
    const id = await newDocument('bad!!');
    // What quarantine does: mark it infected and release its bytes.
    await h.query(`UPDATE documents SET scan_status = 'infected' WHERE id = $1`, [id]);
    await h.query(`UPDATE workspaces SET storage_used_bytes = storage_used_bytes - 5 WHERE id = $1`, [
      owner.workspaceId,
    ]);
    expect(await used()).toBe(5);
    await h.query(`UPDATE documents SET deleted_at = now() WHERE id = $1`, [id]);
    expect((await call(owner, 'DELETE', `/api/documents/${id}/permanent`)).statusCode).toBe(204);
    expect(await used()).toBe(5);
    expect(other).toBeTruthy();
  });
});
