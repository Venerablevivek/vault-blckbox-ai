import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/** Opens a zip from memory and returns every entry's name and bytes, in archive order. */
function unzip(buffer: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('no zip'));
      const entries: Array<{ name: string; data: Buffer }> = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return reject(err ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('bulk actions and zip downloads', () => {
  let h: Harness;
  let owner: User;
  let member: User;
  let viewer: User;

  beforeAll(async () => {
    h = await createHarness({ env: { ARCHIVE_MAX_FILES: '4', ARCHIVE_MAX_BYTES: '2000' } });
  });
  afterAll(async () => h.close());

  const as = (user: User | undefined, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: user ? { cookie: user.cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function join(email: string, role: 'MEMBER' | 'VIEWER'): Promise<User> {
    const user = await registerUser(h.app, email);
    const invite = await as(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, { email, role });
    const token = invite.json().inviteUrl.split('/invite/')[1];
    expect((await as(user, 'POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200);
    return user;
  }

  async function upload(user: User, name: string, text: string): Promise<string> {
    const res = await uploadDocument(h.app, user.cookie, owner.workspaceId, name, Buffer.from(text), 'text/plain');
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document.id;
  }

  async function folder(name: string, parentId: string | null = null): Promise<string> {
    const res = await as(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name, parentId });
    return res.json().folder.id;
  }

  const move = (id: string, folderId: string) => as(owner, 'PATCH', `/api/documents/${id}`, { folderId });
  const archive = (user: User | undefined, query: string) =>
    as(user, 'GET', `/api/workspaces/${owner.workspaceId}/archive?${query}`);

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await join('member@example.com', 'MEMBER');
    viewer = await join('viewer@example.com', 'VIEWER');
  });

  describe('bulk actions', () => {
    it('handles each document on its own: what the caller may not touch fails alone', async () => {
      const mine = await upload(member, 'mine.txt', 'mine');
      const theirs = await upload(owner, 'theirs.txt', 'theirs');
      const res = await as(member, 'POST', '/api/documents/bulk', { action: 'trash', ids: [theirs, mine] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        results: [
          { id: theirs, ok: false, error: { code: 'FORBIDDEN', message: expect.any(String) } },
          { id: mine, ok: true },
        ],
        succeeded: 1,
        failed: 1,
      });
      const trash = await as(owner, 'GET', `/api/workspaces/${owner.workspaceId}/documents?view=trash`);
      expect(trash.json().documents.map((d: { id: string }) => d.id)).toEqual([mine]);
    });

    it('trashes, restores, moves and permanently deletes many documents', async () => {
      const a = await upload(owner, 'a.txt', 'a');
      const b = await upload(owner, 'b.txt', 'b');
      const target = await folder('Archive');

      const moved = await as(owner, 'POST', '/api/documents/bulk', { action: 'move', ids: [a, b], folderId: target });
      expect(moved.json().succeeded).toBe(2);
      const inFolder = await as(owner, 'GET', `/api/workspaces/${owner.workspaceId}/documents?folderId=${target}`);
      expect(inFolder.json().documents).toHaveLength(2);

      expect((await as(owner, 'POST', '/api/documents/bulk', { action: 'trash', ids: [a, b] })).json().succeeded).toBe(
        2,
      );
      expect((await as(owner, 'POST', '/api/documents/bulk', { action: 'restore', ids: [a] })).json().succeeded).toBe(
        1,
      );

      // Only trashed documents can be deleted for good: a is live again.
      const purge = await as(owner, 'POST', '/api/documents/bulk', { action: 'delete', ids: [a, b] });
      expect(purge.json().results).toEqual([
        { id: a, ok: false, error: { code: 'NOT_FOUND', message: 'Document not found.' } },
        { id: b, ok: true },
      ]);
      const events = await h.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE resource_id = $1 ORDER BY seq`,
        [b],
      );
      expect(events.map((e) => e.action)).toEqual([
        'document.uploaded',
        'document.moved',
        'document.trashed',
        'document.purged',
      ]);
    });

    it("reports another workspace's documents as not found, like the single endpoints", async () => {
      const outsider = await registerUser(h.app, 'outsider@example.com');
      const a = await upload(owner, 'a.txt', 'a');
      const res = await as(outsider, 'POST', '/api/documents/bulk', { action: 'trash', ids: [a] });
      expect(res.json().results[0]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect((await as(owner, 'GET', `/api/workspaces/${owner.workspaceId}/documents`)).json().documents).toHaveLength(
        1,
      );
    });

    it('rejects malformed requests before touching anything', async () => {
      const a = await upload(owner, 'a.txt', 'a');
      const bad = [
        { action: 'move', ids: [a] },
        { action: 'trash', ids: [a, a] },
        { action: 'trash', ids: [] },
        { action: 'trash', ids: Array.from({ length: 101 }, () => a) },
        { action: 'shred', ids: [a] },
      ];
      for (const payload of bad) {
        expect((await as(owner, 'POST', '/api/documents/bulk', payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect((await as(undefined, 'POST', '/api/documents/bulk', { action: 'trash', ids: [a] })).statusCode).toBe(401);
    });
  });

  describe('zip downloads', () => {
    it('zips the chosen documents with their exact bytes, numbering duplicate names', async () => {
      const a = await upload(owner, 'notes.txt', 'first notes');
      const b = await upload(member, 'Notes.txt', 'second notes');
      const c = await upload(owner, 'plan.txt', 'the plan');

      const res = await archive(viewer, `ids=${a},${b},${c}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="documents-\d{4}-\d{2}-\d{2}\.zip"/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);

      const entries = await unzip(res.rawPayload);
      expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([
        ['Notes.txt', 'second notes'],
        ['notes (2).txt', 'first notes'],
        ['plan.txt', 'the plan'],
      ]);

      // Each file counts as downloaded by the person who asked for the zip.
      const audit = await h.query<{ resource_id: string; actor_user_id: string; metadata: { archive: string } }>(
        `SELECT resource_id, actor_user_id, metadata FROM audit_events WHERE action = 'document.downloaded'`,
      );
      expect(audit.map((e) => e.resource_id).sort()).toEqual([a, b, c].sort());
      expect(audit.every((e) => e.actor_user_id === viewer.userId && e.metadata.archive.endsWith('.zip'))).toBe(true);
    });

    it('zips a folder with its structure, leaving out trashed files and anything outside it', async () => {
      const reports = await folder('Reports');
      const q1 = await folder('Q1', reports);
      const inRoot = await upload(owner, 'summary.txt', 'summary');
      const inSub = await upload(owner, 'jan.txt', 'january');
      const trashed = await upload(owner, 'old.txt', 'old');
      await upload(owner, 'elsewhere.txt', 'not in the folder');
      await move(inRoot, reports);
      await move(inSub, q1);
      await move(trashed, q1);
      await as(owner, 'DELETE', `/api/documents/${trashed}`);

      const res = await archive(owner, `folderId=${reports}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-disposition']).toContain(`filename="Reports.zip"`);
      const entries = await unzip(res.rawPayload);
      expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([
        ['summary.txt', 'summary'],
        ['Q1/jan.txt', 'january'],
      ]);
    });

    it('leaves out files the malware scan has not cleared, and says so inside the zip', async () => {
      const ok = await upload(owner, 'ok.txt', 'fine');
      const pending = await upload(owner, 'waiting.txt', 'not yet');
      await h.query(`UPDATE documents SET scan_status = 'pending' WHERE id = $1`, [pending]);

      const summary = await as(
        owner,
        'GET',
        `/api/workspaces/${owner.workspaceId}/archive/summary?ids=${ok},${pending}`,
      );
      expect(summary.json()).toEqual({ filename: expect.stringMatching(/\.zip$/), files: 1, bytes: 4, skipped: 1 });
      // Summaries record nothing.
      const recorded = await h.query(`SELECT 1 FROM audit_events WHERE action = 'document.downloaded'`);
      expect(recorded).toHaveLength(0);

      const entries = await unzip((await archive(owner, `ids=${ok},${pending}`)).rawPayload);
      expect(entries.map((e) => e.name)).toEqual(['ok.txt', 'NOT-INCLUDED.txt']);
      expect(entries[1]!.data.toString()).toContain('waiting.txt (still being checked for malware)');

      for (const url of [`archive?ids=${pending}`, `archive/summary?ids=${pending}`]) {
        const none = await as(owner, 'GET', `/api/workspaces/${owner.workspaceId}/${url}`);
        expect(none.statusCode).toBe(409);
        expect(none.json().error.code).toBe('NOTHING_TO_DOWNLOAD');
      }
    });

    it('names non-ASCII archives safely in the header', async () => {
      const f = await folder('Relatório "final"');
      await move(await upload(owner, 'a.txt', 'a'), f);
      const res = await archive(owner, `folderId=${f}`);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="Relat_rio _final_.zip"; filename*=UTF-8''Relat%C3%B3rio%20%22final%22.zip`,
      );
    });

    it('refuses archives over the file or size limit before reading storage', async () => {
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push(await upload(owner, `f${i}.txt`, 'x'));
      const tooMany = await archive(owner, `ids=${ids.join(',')}`);
      expect(tooMany.statusCode).toBe(413);
      expect(tooMany.json().error.code).toBe('ARCHIVE_TOO_LARGE');
      expect((await archive(owner, `ids=${ids.slice(0, 4).join(',')}`)).statusCode).toBe(200);

      const big = await upload(owner, 'big.txt', 'y'.repeat(2001));
      expect((await archive(owner, `ids=${big}`)).statusCode).toBe(413);
    });

    it('never reveals documents or folders from another workspace', async () => {
      const outsider = await registerUser(h.app, 'outsider@example.com');
      const secret = await upload(owner, 'secret.txt', 'secret');
      const secretFolder = await folder('Secret');

      // Outsider asking for the owner's workspace: not a member.
      expect((await archive(outsider, `ids=${secret}`)).statusCode).toBe(404);
      // Outsider asking in their own workspace for the owner's ids: nothing matches.
      const own = (query: string) => as(outsider, 'GET', `/api/workspaces/${outsider.workspaceId}/archive?${query}`);
      expect((await own(`ids=${secret}`)).statusCode).toBe(404);
      expect((await own(`folderId=${secretFolder}`)).statusCode).toBe(404);
      expect((await archive(undefined, `ids=${secret}`)).statusCode).toBe(401);
    });

    it('rejects a selection that is missing, doubled up or malformed', async () => {
      const a = await upload(owner, 'a.txt', 'a');
      const f = await folder('F');
      for (const query of ['', `ids=${a}&folderId=${f}`, 'ids=', 'ids=not-a-uuid', `ids=${a},nope`]) {
        expect((await archive(owner, query)).statusCode, query).toBe(400);
      }
      const empty = await archive(owner, `folderId=${f}`);
      expect(empty.statusCode).toBe(409);
    });

    it('cuts the download short if a file has gone missing from storage', async () => {
      const a = await upload(owner, 'a.txt', 'a');
      const b = await upload(owner, 'b.txt', 'b');
      const [row] = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [b]);
      await h.storage.delete(row!.storage_key);

      // The status line has gone out, so the only signal left is ending the response early.
      // More failures than there are archive slots (4): each one must give its slot back.
      for (let i = 0; i < 5; i += 1) {
        await expect(archive(owner, `ids=${a},${b}`)).rejects.toThrow(/destroyed before completion/);
      }
      expect((await archive(owner, `ids=${a}`)).statusCode).toBe(200);
    });
  });
});
