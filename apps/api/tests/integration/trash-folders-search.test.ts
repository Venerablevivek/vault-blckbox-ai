import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('trash, folders, search and maintenance', () => {
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

  const call = (method: string, url: string, cookie: string | undefined, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const upload = async (name: string, folderId?: string, user: User = alice) => {
    const url = folderId ? `/api/workspaces/${user.workspaceId}/documents?folderId=${folderId}` : undefined;
    const response = url
      ? await h.app.inject({
          method: 'POST',
          url,
          headers: {
            cookie: user.cookie,
            'content-type': 'multipart/form-data; boundary=----b',
          },
          payload: Buffer.concat([
            Buffer.from(
              `------b\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
            ),
            Buffer.from('%PDF-1.4\nbody\n%%EOF\n'),
            Buffer.from('\r\n------b--\r\n'),
          ]),
        })
      : await uploadDocument(h.app, user.cookie, user.workspaceId, name);
    expect(response.statusCode).toBe(201);
    return response.json().document.id as string;
  };

  const signIn = async (email: string) => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'password123' },
    });
    return String(response.headers['set-cookie']).split(';')[0]!;
  };

  const list = (query = '', user: User = alice) =>
    call('GET', `/api/workspaces/${user.workspaceId}/documents${query}`, user.cookie);
  const names = (response: { json(): { documents: Array<{ filename: string }> } }) =>
    response.json().documents.map((d) => d.filename);

  // ---------------------------------------------------------------- trash

  describe('trash and restore', () => {
    it('moves a document to the trash, revokes its links, and restores it without them', async () => {
      const id = await upload('contract.pdf');
      const share = await call('POST', '/api/shares', alice.cookie, { documentId: id });
      const token = share.json().share.url.split('/s/')[1];

      const trashed = await call('DELETE', `/api/documents/${id}`, alice.cookie);
      expect(trashed.statusCode).toBe(200);
      expect(trashed.json().revokedLinks).toBe(1);

      expect(names(await list())).not.toContain('contract.pdf');
      const trash = await list('?view=trash');
      expect(names(trash)).toContain('contract.pdf');
      expect(trash.json().documents[0].deletedByEmail).toBe('alice@example.com');
      expect((await call('GET', `/api/documents/${id}/download`, alice.cookie)).statusCode).toBe(404);

      expect((await call('POST', `/api/documents/${id}/restore`, alice.cookie)).statusCode).toBe(200);
      expect(names(await list())).toContain('contract.pdf');
      expect((await call('GET', `/api/documents/${id}/download`, alice.cookie)).statusCode).toBe(302);

      // Deleting was how the sender stopped sharing; restoring does not quietly re-open access.
      expect((await call('GET', `/api/shares/${token}`, undefined)).statusCode).toBe(410);
    });

    it('lets only an owner delete permanently, and a member restore only their own', async () => {
      const bob = await registerUser(h.app, 'bob@example.com');
      const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'bob@example.com',
      });
      await call('POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`, bob.cookie);

      const alicesDoc = await upload('alices.pdf');
      const bobsDoc = await upload('bobs.pdf', undefined, { ...bob, workspaceId: alice.workspaceId });
      await call('DELETE', `/api/documents/${alicesDoc}`, alice.cookie);
      await call('DELETE', `/api/documents/${bobsDoc}`, bob.cookie);

      expect((await call('POST', `/api/documents/${alicesDoc}/restore`, bob.cookie)).statusCode).toBe(403);
      expect((await call('POST', `/api/documents/${bobsDoc}/restore`, bob.cookie)).statusCode).toBe(200);
      await call('DELETE', `/api/documents/${bobsDoc}`, bob.cookie);
      expect((await call('DELETE', `/api/documents/${bobsDoc}/permanent`, bob.cookie)).statusCode).toBe(403);
      expect((await call('DELETE', `/api/documents/${bobsDoc}/permanent`, alice.cookie)).statusCode).toBe(204);
    });

    it('hides the trash from other workspaces', async () => {
      const id = await upload('secret.pdf');
      await call('DELETE', `/api/documents/${id}`, alice.cookie);
      const eve = await registerUser(h.app, 'eve@example.com');
      expect((await call('POST', `/api/documents/${id}/restore`, eve.cookie)).statusCode).toBe(404);
      expect((await call('DELETE', `/api/documents/${id}/permanent`, eve.cookie)).statusCode).toBe(404);
      expect(
        (await call('GET', `/api/workspaces/${alice.workspaceId}/documents?view=trash`, eve.cookie)).statusCode,
      ).toBe(404);
    });
  });

  // ---------------------------------------------------------------- folders

  describe('folders', () => {
    const createFolder = async (name: string, parentId: string | null = null, user: User = alice) =>
      call('POST', `/api/workspaces/${user.workspaceId}/folders`, user.cookie, { name, parentId });

    it('nests folders, uploads into them and lists each level with its path', async () => {
      const clients = (await createFolder('Clients')).json().folder.id;
      const acme = (await createFolder('Acme', clients)).json().folder.id;
      await upload('acme-contract.pdf', acme);
      await upload('root-note.pdf');

      const root = await list();
      expect(names(root)).toEqual(['root-note.pdf']);
      expect(root.json().folders.map((f: { name: string }) => f.name)).toEqual(['Clients']);

      const inside = await list(`?folderId=${acme}`);
      expect(names(inside)).toEqual(['acme-contract.pdf']);
      expect(inside.json().path.map((f: { name: string }) => f.name)).toEqual(['Clients', 'Acme']);
    });

    it('rejects duplicate sibling names, case-insensitively', async () => {
      await createFolder('Invoices');
      const again = await createFolder('invoices');
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('FOLDER_NAME_TAKEN');
    });

    it('refuses to move a folder inside itself or its own subfolder', async () => {
      const a = (await createFolder('A')).json().folder.id;
      const b = (await createFolder('B', a)).json().folder.id;
      const intoChild = await call('PATCH', `/api/workspaces/${alice.workspaceId}/folders/${a}`, alice.cookie, {
        parentId: b,
      });
      expect(intoChild.statusCode).toBe(422);
      expect(intoChild.json().error.code).toBe('FOLDER_CYCLE');
      const intoSelf = await call('PATCH', `/api/workspaces/${alice.workspaceId}/folders/${a}`, alice.cookie, {
        parentId: a,
      });
      expect(intoSelf.statusCode).toBe(422);
    });

    it('refuses to delete a folder that still has documents or subfolders', async () => {
      const folder = (await createFolder('Busy')).json().folder.id;
      const doc = await upload('inside.pdf', folder);
      const refused = await call('DELETE', `/api/workspaces/${alice.workspaceId}/folders/${folder}`, alice.cookie);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('FOLDER_NOT_EMPTY');

      // A trashed document does not keep a folder alive; restoring it later lands at the root.
      await call('DELETE', `/api/documents/${doc}`, alice.cookie);
      expect(
        (await call('DELETE', `/api/workspaces/${alice.workspaceId}/folders/${folder}`, alice.cookie)).statusCode,
      ).toBe(204);
      await call('POST', `/api/documents/${doc}/restore`, alice.cookie);
      expect(names(await list())).toContain('inside.pdf');
    });

    it('moves documents between folders', async () => {
      const folder = (await createFolder('Archive')).json().folder.id;
      const doc = await upload('old.pdf');
      expect((await call('PATCH', `/api/documents/${doc}`, alice.cookie, { folderId: folder })).statusCode).toBe(200);
      expect(names(await list())).not.toContain('old.pdf');
      expect(names(await list(`?folderId=${folder}`))).toContain('old.pdf');
      expect((await call('PATCH', `/api/documents/${doc}`, alice.cookie, { folderId: null })).statusCode).toBe(200);
      expect(names(await list())).toContain('old.pdf');
    });

    it("cannot target another workspace's folder", async () => {
      const eve = await registerUser(h.app, 'eve@example.com');
      const evesFolder = (await createFolder('Eve', null, eve)).json().folder.id;
      const doc = await upload('mine.pdf');

      expect((await call('PATCH', `/api/documents/${doc}`, alice.cookie, { folderId: evesFolder })).statusCode).toBe(
        404,
      );
      const intoOther = await h.app.inject({
        method: 'POST',
        url: `/api/workspaces/${alice.workspaceId}/documents?folderId=${evesFolder}`,
        headers: { cookie: alice.cookie, 'content-type': 'multipart/form-data; boundary=----b' },
        payload: Buffer.concat([
          Buffer.from(
            '------b\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
          ),
          Buffer.from('%PDF-1.4\nx\n%%EOF\n'),
          Buffer.from('\r\n------b--\r\n'),
        ]),
      });
      expect(intoOther.statusCode).toBe(404);
      expect(
        (await call('GET', `/api/workspaces/${alice.workspaceId}/documents?folderId=${evesFolder}`, alice.cookie))
          .statusCode,
      ).toBe(404);
      expect(
        (await call('DELETE', `/api/workspaces/${eve.workspaceId}/folders/${evesFolder}`, alice.cookie)).statusCode,
      ).toBe(404);
    });
  });

  // ---------------------------------------------------------------- search & pagination

  describe('server-side search and pagination', () => {
    it('searches the whole workspace, across folders', async () => {
      const folder = (
        await call('POST', `/api/workspaces/${alice.workspaceId}/folders`, alice.cookie, { name: 'Deep' })
      ).json().folder.id;
      await upload('Quarterly-Report.pdf', folder);
      await upload('quarterly-summary.pdf');
      await upload('invoice.pdf');

      const found = await list('?q=QUARTERLY');
      expect(names(found).sort()).toEqual(['Quarterly-Report.pdf', 'quarterly-summary.pdf']);
      // Folders are not listed while searching.
      expect(found.json().folders).toEqual([]);
    });

    it('treats % and _ in a search as literal characters', async () => {
      await upload('growth_50%.pdf');
      await upload('growth-500.pdf');
      expect(names(await list(`?q=${encodeURIComponent('50%')}`))).toEqual(['growth_50%.pdf']);
      expect(names(await list(`?q=${encodeURIComponent('h_5')}`))).toEqual(['growth_50%.pdf']);
    });

    it('pages through every document exactly once, for every sort', async () => {
      for (let i = 0; i < 23; i += 1) {
        // Duplicate names on purpose: ties must still page correctly thanks to the id tiebreak.
        await upload(`doc-${String(i % 5).padStart(2, '0')}.pdf`);
      }
      for (const sort of ['date', 'name', 'size']) {
        for (const order of ['asc', 'desc']) {
          const seen: string[] = [];
          let cursor: string | null = null;
          let pages = 0;
          do {
            const response = await list(`?sort=${sort}&order=${order}&limit=5${cursor ? `&cursor=${cursor}` : ''}`);
            expect(response.statusCode).toBe(200);
            seen.push(...response.json().documents.map((d: { id: string }) => d.id));
            cursor = response.json().nextCursor;
            pages += 1;
          } while (cursor && pages < 20);
          expect(seen, `${sort} ${order}`).toHaveLength(23);
          expect(new Set(seen).size, `${sort} ${order}`).toBe(23);
        }
      }
    });

    it('rejects a tampered cursor', async () => {
      const response = await list('?cursor=not-a-real-cursor');
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_CURSOR');
    });

    it('filters to shared and to my uploads, with counts', async () => {
      const shared = await upload('shared.pdf');
      await upload('private.pdf');
      await call('POST', '/api/shares', alice.cookie, { documentId: shared });
      expect(names(await list('?filter=shared'))).toEqual(['shared.pdf']);
      expect((await list()).json().counts).toMatchObject({ all: 2, shared: 1, mine: 2, trash: 0 });
    });

    it("never returns another workspace's documents in search results", async () => {
      await upload('alice-secret-plan.pdf');
      const eve = await registerUser(h.app, 'eve@example.com');
      const response = await list('?q=secret', eve);
      expect(response.statusCode).toBe(200);
      expect(response.json().documents).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- maintenance

  describe('maintenance', () => {
    it('purges trash past retention, removing the object, and leaves recent trash alone', async () => {
      const old = await upload('old.pdf');
      await call('DELETE', `/api/documents/${old}`, alice.cookie);
      const [oldRow] = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [old]);
      const oldKey = oldRow!.storage_key;

      h.clock.advanceHours(24 * (h.config.TRASH_RETENTION_DAYS + 1));
      // Moving time past retention also expired Alice's session; sign in again.
      alice = { ...alice, cookie: await signIn('alice@example.com') };

      const recent = await upload('recent.pdf');
      await call('DELETE', `/api/documents/${recent}`, alice.cookie);

      const result = await h.app.maintenance.runOnce();
      expect(result).toMatchObject({ trashPurged: 1, trashFailed: 0 });
      expect(await h.query('SELECT 1 FROM documents WHERE id = $1', [old])).toHaveLength(0);
      expect(await h.objectExists(oldKey)).toBe(false);
      expect(await h.query('SELECT 1 FROM documents WHERE id = $1', [recent])).toHaveLength(1);

      // The audit trail outlives the purged document.
      const events = (await call('GET', `/api/workspaces/${alice.workspaceId}/audit`, alice.cookie)).json().events;
      expect(
        events.some(
          (e: { action: string; metadata: { reason?: string } }) =>
            e.action === 'document.purged' && e.metadata.reason === 'retention',
        ),
      ).toBe(true);
    });

    it('removes expired sessions, old login failures, stale notifications and expired invitations', async () => {
      await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
        email: 'late@example.com',
      });
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'alice@example.com', password: 'wrong-password' },
      });
      await h.query(
        `INSERT INTO notifications (id, user_id, type, title, read_at, created_at)
         VALUES (gen_random_uuid(), $1, 'member.joined', 'old and read', now(), $2)`,
        [alice.userId, new Date(h.clock.now().getTime() - 40 * 86_400_000)],
      );

      h.clock.advanceHours(24 * 30);
      const result = await h.app.maintenance.runOnce();

      expect(result!.expiredSessions).toBeGreaterThanOrEqual(1);
      expect(result!.loginFailures).toBe(1);
      expect(result!.notifications).toBeGreaterThanOrEqual(1);
      expect(result!.expiredInvitations).toBe(1);
    });
  });

  // ---------------------------------------------------------------- time zones

  describe('dashboard time zones', () => {
    it("groups activity by the viewer's calendar day, not UTC", async () => {
      const id = await upload('late-night.pdf');
      // 02:00 UTC on 1 Jan is 21:00 on 31 Dec in New York. The harness clock is 12:00 UTC 1 Jan.
      await h.query("UPDATE documents SET created_at = '2026-01-01T02:00:00Z' WHERE id = $1", [id]);

      const utc = (await call('GET', `/api/workspaces/${alice.workspaceId}/overview?tz=UTC`, alice.cookie)).json()
        .series;
      const ny = (
        await call('GET', `/api/workspaces/${alice.workspaceId}/overview?tz=America/New_York`, alice.cookie)
      ).json().series;

      expect(utc.find((d: { day: string }) => d.day === '2026-01-01').uploads).toBe(1);
      expect(ny.find((d: { day: string }) => d.day === '2025-12-31').uploads).toBe(1);
      expect(ny.find((d: { day: string }) => d.day === '2026-01-01').uploads).toBe(0);
    });

    it('falls back to UTC for an unknown time zone', async () => {
      const response = await call('GET', `/api/workspaces/${alice.workspaceId}/overview?tz=Mars/Olympus`, alice.cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json().series).toHaveLength(14);
    });
  });
});
