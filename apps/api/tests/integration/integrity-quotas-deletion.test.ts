import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, SAMPLE_PDF, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/** Checksums, storage quotas and deleting a workspace. */
describe('integrity, quotas and workspace deletion', () => {
  let h: Harness;
  let alice: User;

  beforeAll(async () => {
    // Jobs run only when a test calls runJobs(), so "the moment of deletion" can be observed
    // before the purge job removes the workspace.
    h = await createHarness({ worker: false });
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
  });

  const call = (method: string, url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`, 'utf8');
  const usage = async () =>
    (
      await h.query<{ storage_used_bytes: string }>('SELECT storage_used_bytes FROM workspaces WHERE id = $1', [
        alice.workspaceId,
      ])
    )[0]!.storage_used_bytes;

  describe('checksums', () => {
    it('records the SHA-256 of the stored bytes', async () => {
      const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
      expect(upload.statusCode).toBe(201);
      const expected = createHash('sha256').update(SAMPLE_PDF).digest('hex');
      expect(upload.json().document.sha256).toBe(expected);
      expect(upload.json().duplicateOf).toBeNull();

      const list = await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, alice.cookie);
      expect(list.json().documents[0].sha256).toBe(expected);
    });

    it('points out an upload identical to a live document, but still accepts it', async () => {
      const first = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'original.pdf');
      const second = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'copy.pdf');
      expect(second.statusCode).toBe(201);
      expect(second.json().duplicateOf).toEqual({ id: first.json().document.id, filename: 'original.pdf' });

      // A trashed original is not a duplicate: it's on its way out.
      await call('DELETE', `/api/documents/${first.json().document.id}`, alice.cookie);
      const third = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'third.pdf', pdf('different'));
      expect(third.json().duplicateOf).toBeNull();
    });

    it('never matches a duplicate in another workspace', async () => {
      const bob = await registerUser(h.app, 'bob@example.com');
      await uploadDocument(h.app, bob.cookie, bob.workspaceId, 'bobs.pdf');
      const mine = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'mine.pdf');
      expect(mine.json().duplicateOf).toBeNull();
    });

    it('backfills checksums for documents stored before they existed', async () => {
      const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
      const id = upload.json().document.id;
      await h.query('UPDATE documents SET sha256 = NULL WHERE id = $1', [id]);

      const result = await h.app.maintenance.runOnce();
      expect(result!.checksumsBackfilled).toBe(1);
      const rows = await h.query<{ sha256: Buffer }>('SELECT sha256 FROM documents WHERE id = $1', [id]);
      expect(rows[0]!.sha256.toString('hex')).toBe(createHash('sha256').update(SAMPLE_PDF).digest('hex'));
    });
  });

  describe('storage quota', () => {
    it('counts uploads, keeps counting trashed files, and releases space on permanent delete', async () => {
      const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
      const id = upload.json().document.id;
      expect(Number(await usage())).toBe(SAMPLE_PDF.length);

      await call('DELETE', `/api/documents/${id}`, alice.cookie);
      expect(Number(await usage())).toBe(SAMPLE_PDF.length);

      expect((await call('DELETE', `/api/documents/${id}/permanent`, alice.cookie)).statusCode).toBe(204);
      expect(Number(await usage())).toBe(0);
    });

    it('refuses a file that does not fit, storing nothing', async () => {
      await h.query('UPDATE workspaces SET storage_quota_bytes = $2 WHERE id = $1', [
        alice.workspaceId,
        SAMPLE_PDF.length + 10,
      ]);
      expect((await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'a.pdf')).statusCode).toBe(201);

      const refused = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'b.pdf', pdf('another file'));
      expect(refused.statusCode).toBe(413);
      expect(refused.json().error.code).toBe('QUOTA_EXCEEDED');
      expect(await h.query('SELECT 1 FROM documents')).toHaveLength(1);
      expect(Number(await usage())).toBe(SAMPLE_PDF.length);
    });

    it('never lets concurrent uploads overshoot the quota, and leaves no orphaned objects', async () => {
      await h.query('UPDATE workspaces SET storage_quota_bytes = $2 WHERE id = $1', [
        alice.workspaceId,
        Math.floor(SAMPLE_PDF.length * 1.5),
      ]);
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          uploadDocument(h.app, alice.cookie, alice.workspaceId, `race-${i}.pdf`, pdf(`race ${i}`.padEnd(24, '.'))),
        ),
      );
      const accepted = results.filter((r) => r.statusCode === 201);
      expect(accepted).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 413)).toHaveLength(2);

      const rows = await h.query<{ size: string }>('SELECT size FROM documents');
      expect(rows).toHaveLength(1);
      expect(Number(await usage())).toBe(Number(rows[0]!.size));
    });

    it('reports usage in the document list and on the dashboard', async () => {
      await uploadDocument(h.app, alice.cookie, alice.workspaceId);
      const list = await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, alice.cookie);
      expect(list.json().storage).toEqual({ usedBytes: SAMPLE_PDF.length, quotaBytes: 5 * 1024 ** 3 });
      const overview = await call('GET', `/api/workspaces/${alice.workspaceId}/overview`, alice.cookie);
      expect(overview.json().storage).toEqual({ usedBytes: SAMPLE_PDF.length, quotaBytes: 5 * 1024 ** 3 });
    });

    it('releases space when expired trash is purged', async () => {
      const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
      await call('DELETE', `/api/documents/${upload.json().document.id}`, alice.cookie);
      h.clock.advanceHours(24 * 31);
      await h.app.maintenance.runOnce();
      expect(Number(await usage())).toBe(0);
    });
  });

  describe('deleting a workspace', () => {
    let bob: User;
    let documentId: string;
    let storageKey: string;
    let shareToken: string;

    beforeEach(async () => {
      bob = await registerUser(h.app, 'bob@example.com');
      const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'bob@example.com',
      });
      await call('POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`, bob.cookie);
      await call('PATCH', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { name: 'Acme Legal' });

      const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
      documentId = upload.json().document.id;
      storageKey = (
        await h.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [documentId])
      )[0]!.storage_key;
      shareToken = (await call('POST', '/api/shares', alice.cookie, { documentId })).json().share.url.split('/s/')[1];
    });

    it('is owner-only and requires the exact name', async () => {
      const member = await call('DELETE', `/api/workspaces/${alice.workspaceId}`, bob.cookie, {
        confirmName: 'Acme Legal',
      });
      expect(member.statusCode).toBe(403);

      const wrong = await call('DELETE', `/api/workspaces/${alice.workspaceId}`, alice.cookie, {
        confirmName: 'acme legal',
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe('CONFIRMATION_MISMATCH');

      const outsider = await registerUser(h.app, 'eve@example.com');
      expect(
        (await call('DELETE', `/api/workspaces/${alice.workspaceId}`, outsider.cookie, { confirmName: 'Acme Legal' }))
          .statusCode,
      ).toBe(404);
    });

    it('ends access for everyone at once and kills its links and invitations', async () => {
      const pending = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'carol@example.com',
      });
      const inviteToken = pending.json().inviteUrl.split('/invite/')[1];

      expect(
        (await call('DELETE', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { confirmName: 'Acme Legal' }))
          .statusCode,
      ).toBe(204);

      for (const user of [alice, bob]) {
        expect((await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, user.cookie)).statusCode).toBe(404);
        expect((await call('GET', `/api/documents/${documentId}/download`, user.cookie)).statusCode).toBe(404);
        const me = await call('GET', '/api/auth/me', user.cookie);
        expect(me.json().workspaces.map((w: { id: string }) => w.id)).not.toContain(alice.workspaceId);
      }
      expect((await call('GET', `/api/shares/${shareToken}`)).statusCode).toBe(410);
      expect((await call('GET', `/api/invitations/${inviteToken}`)).statusCode).toBe(404);
    });

    it('tells the other members, without naming a workspace they can no longer open', async () => {
      await call('DELETE', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { confirmName: 'Acme Legal' });
      // Notifications are written after the response: wait for it rather than a fixed time.
      await expect
        .poll(async () =>
          (
            (await call('GET', '/api/notifications', bob.cookie)).json().notifications as Array<{
              type: string;
              title: string;
            }>
          ).some((n) => n.type === 'workspace.deleted' && n.title === 'Acme Legal was deleted'),
        )
        .toBe(true);
      const aliceNotes = (await call('GET', '/api/notifications', alice.cookie)).json().notifications as Array<{
        type: string;
      }>;
      expect(aliceNotes.some((n) => n.type === 'workspace.deleted')).toBe(false);
    });

    it('removes the files and rows in a background job straight away', async () => {
      await call('DELETE', `/api/documents/${documentId}`, alice.cookie);
      await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'live.pdf', pdf('still live'));
      await call('DELETE', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { confirmName: 'Acme Legal' });
      expect(await h.objectExists(storageKey)).toBe(true);

      expect(await h.runJobs()).toBeGreaterThanOrEqual(1);
      expect(await h.objectExists(storageKey)).toBe(false);
      expect(await h.query('SELECT 1 FROM workspaces WHERE id = $1', [alice.workspaceId])).toHaveLength(0);
      expect(await h.query('SELECT 1 FROM documents WHERE workspace_id = $1', [alice.workspaceId])).toHaveLength(0);
      expect(await h.query('SELECT 1 FROM workspaces WHERE id = $1', [bob.workspaceId])).toHaveLength(1);
    });

    it('is finished by the maintenance pass if the job never ran', async () => {
      await call('DELETE', `/api/documents/${documentId}`, alice.cookie);
      await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'live.pdf', pdf('still live'));
      await call('POST', `/api/workspaces/${alice.workspaceId}/folders`, alice.cookie, { name: 'Parent' });

      await call('DELETE', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { confirmName: 'Acme Legal' });
      expect(await h.objectExists(storageKey)).toBe(true);

      const result = await h.app.maintenance.runOnce();
      expect(result!.workspacesPurged).toBe(1);
      expect(await h.objectExists(storageKey)).toBe(false);
      expect(await h.query('SELECT 1 FROM workspaces WHERE id = $1', [alice.workspaceId])).toHaveLength(0);
      expect(await h.query('SELECT 1 FROM documents WHERE workspace_id = $1', [alice.workspaceId])).toHaveLength(0);
      // Bob's own workspace is untouched.
      expect(await h.query('SELECT 1 FROM workspaces WHERE id = $1', [bob.workspaceId])).toHaveLength(1);
    });

    it('cleans up nested folders when the workspace row is removed', async () => {
      const parent = (
        await call('POST', `/api/workspaces/${alice.workspaceId}/folders`, alice.cookie, { name: 'Parent' })
      ).json().folder.id;
      await call('POST', `/api/workspaces/${alice.workspaceId}/folders`, alice.cookie, {
        name: 'Child',
        parentId: parent,
      });

      await call('DELETE', `/api/workspaces/${alice.workspaceId}`, alice.cookie, { confirmName: 'Acme Legal' });
      const result = await h.app.maintenance.runOnce();
      expect(result!.workspacesPurged).toBe(1);
      expect(await h.query('SELECT 1 FROM folders WHERE workspace_id = $1', [alice.workspaceId])).toHaveLength(0);
    });
  });
});
