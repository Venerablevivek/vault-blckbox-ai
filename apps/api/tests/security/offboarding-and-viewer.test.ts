import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/**
 * What happens to someone's access when they leave or are downgraded, and what a VIEWER can
 * and cannot do. Found in review: a removed member's share links kept working, and the
 * removed person kept receiving notifications naming workspace documents.
 */
describe('offboarding and the viewer role', () => {
  let h: Harness;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (method: string, url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function join(user: User, email: string, role: 'MEMBER' | 'VIEWER') {
    const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, { email, role });
    const token = invite.json().inviteUrl.split('/invite/')[1];
    await call('POST', `/api/invitations/${token}/accept`, user.cookie);
  }

  async function bobSharesADocument() {
    const upload = await uploadDocument(h.app, bob.cookie, alice.workspaceId, 'Confidential-Roadmap.pdf');
    const documentId = upload.json().document.id;
    const share = await call('POST', '/api/shares', bob.cookie, { documentId });
    return { documentId, token: share.json().share.url.split('/s/')[1] as string };
  }

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    bob = await registerUser(h.app, 'bob@example.com');
    await join(bob, 'bob@example.com', 'MEMBER');
  });

  describe('removing a member', () => {
    it('revokes every share link they created, in the same request', async () => {
      const { token } = await bobSharesADocument();
      expect((await call('GET', `/api/shares/${token}`)).statusCode).toBe(200);

      expect((await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie)).statusCode).toBe(204);

      expect((await call('GET', `/api/shares/${token}`)).statusCode).toBe(410);
    });

    it('keeps their documents in the workspace', async () => {
      await bobSharesADocument();
      await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie);
      const list = await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, alice.cookie);
      expect(list.json().documents.map((d: { filename: string }) => d.filename)).toContain('Confidential-Roadmap.pdf');
    });

    it('also revokes links when someone leaves on their own', async () => {
      const { token } = await bobSharesADocument();
      await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, bob.cookie);
      expect((await call('GET', `/api/shares/${token}`)).statusCode).toBe(410);
    });

    it('stops showing them notifications that name workspace documents', async () => {
      const { token } = await bobSharesADocument();
      await call('POST', `/api/shares/${token}/view`);
      await settle();
      const before = (await call('GET', '/api/notifications', bob.cookie)).json();
      expect(before.notifications.some((n: { title: string }) => n.title.includes('Confidential-Roadmap.pdf'))).toBe(true);

      await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie);

      const after = (await call('GET', '/api/notifications', bob.cookie)).json();
      const titles = after.notifications.map((n: { title: string }) => n.title);
      expect(titles.some((t: string) => t.includes('Confidential-Roadmap.pdf'))).toBe(false);
      // The removal notice itself has no workspace attached, so it is still shown.
      expect(titles.some((t: string) => t.startsWith('You were removed'))).toBe(true);
      expect(after.unread).toBe(after.notifications.filter((n: { read: boolean }) => !n.read).length);
    });

    it('records how many links were revoked in the audit trail', async () => {
      await bobSharesADocument();
      await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie);
      const events = (await call('GET', `/api/workspaces/${alice.workspaceId}/audit`, alice.cookie)).json().events;
      const removed = events.find((e: { action: string }) => e.action === 'member.removed');
      expect(removed.metadata.revokedLinks).toBe(1);
    });
  });

  describe('downgrading to viewer', () => {
    it('revokes the links the person created', async () => {
      const { token } = await bobSharesADocument();
      const change = await call('PATCH', `/api/workspaces/${alice.workspaceId}/members/${bob.userId}`, alice.cookie, { role: 'VIEWER' });
      expect(change.statusCode).toBe(204);
      expect((await call('GET', `/api/shares/${token}`)).statusCode).toBe(410);
    });
  });

  describe('a viewer', () => {
    let carol: User;
    let documentId: string;

    beforeEach(async () => {
      carol = await registerUser(h.app, 'carol@example.com');
      await join(carol, 'carol@example.com', 'VIEWER');
      documentId = (await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'handbook.pdf')).json().document.id;
    });

    it('can list, preview and download', async () => {
      expect((await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, carol.cookie)).json().documents).toHaveLength(1);
      expect((await call('GET', `/api/documents/${documentId}/preview`, carol.cookie)).statusCode).toBe(302);
      expect((await call('GET', `/api/documents/${documentId}/download`, carol.cookie)).statusCode).toBe(302);
      expect((await call('GET', `/api/workspaces/${alice.workspaceId}/members`, carol.cookie)).statusCode).toBe(200);
    });

    it('cannot upload, share, create folders, rename, move or delete', async () => {
      expect((await uploadDocument(h.app, carol.cookie, alice.workspaceId)).statusCode).toBe(403);
      expect((await call('POST', '/api/shares', carol.cookie, { documentId })).statusCode).toBe(403);
      expect((await call('POST', `/api/workspaces/${alice.workspaceId}/folders`, carol.cookie, { name: 'Mine' })).statusCode).toBe(403);
      expect((await call('PATCH', `/api/documents/${documentId}`, carol.cookie, { filename: 'x.pdf' })).statusCode).toBe(403);
      expect((await call('DELETE', `/api/documents/${documentId}`, carol.cookie)).statusCode).toBe(403);
      expect((await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, carol.cookie, { email: 'x@example.com' })).statusCode).toBe(403);
      expect((await call('GET', `/api/workspaces/${alice.workspaceId}/audit`, carol.cookie)).statusCode).toBe(403);
    });

    it('explains the restriction in the error', async () => {
      const response = await uploadDocument(h.app, carol.cookie, alice.workspaceId);
      expect(response.json().error.message).toMatch(/Viewers can't upload/);
    });

    it('can leave the workspace', async () => {
      expect((await call('DELETE', `/api/workspaces/${alice.workspaceId}/members/${carol.userId}`, carol.cookie)).statusCode).toBe(204);
    });
  });
});
