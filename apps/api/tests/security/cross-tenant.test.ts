import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

/**
 * Blueprint test area 1: "Non-member cannot access another workspace or its documents."
 *
 * Table-driven so that adding a route without wiring its authorization check breaks this
 * suite. The last four entries matter most: they are addressed by object id with no
 * workspace in the path, so their check lives in the service rather than inherited from
 * a route prefix.
 */
describe('cross-tenant access', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<typeof registerUser>>;
  let bob: Awaited<ReturnType<typeof registerUser>>;
  let aliceDocId: string;
  let aliceShareId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    bob = await registerUser(h.app, 'bob@example.com');

    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    aliceDocId = upload.json().document.id;

    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: aliceDocId },
    });
    aliceShareId = share.json().share.id;
  });

  it("returns 404 for every one of Alice's resources when Bob asks", async () => {
    const attempts: Array<[string, string]> = [
      ['GET', `/api/workspaces/${alice.workspaceId}/documents`],
      ['GET', `/api/workspaces/${alice.workspaceId}/members`],
      ['POST', `/api/workspaces/${alice.workspaceId}/invitations`],
      ['GET', `/api/documents/${aliceDocId}/download`],
      ['GET', `/api/documents/${aliceDocId}/shares`],
      ['DELETE', `/api/documents/${aliceDocId}`],
      ['DELETE', `/api/shares/${aliceShareId}`],
    ];

    for (const [method, url] of attempts) {
      const response = await h.app.inject({
        method: method as 'GET',
        url,
        headers: { cookie: bob.cookie },
        ...(method === 'POST' ? { payload: { email: 'x@example.com' } } : {}),
      });
      expect.soft(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('refuses to create a share link for a document in another workspace', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: bob.cookie },
      payload: { documentId: aliceDocId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to upload into another workspace', async () => {
    const response = await uploadDocument(h.app, bob.cookie, alice.workspaceId);
    expect(response.statusCode).toBe(404);
  });

  it("does not list Alice's documents in Bob's own workspace", async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bob.workspaceId}/documents`,
      headers: { cookie: bob.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().documents).toHaveLength(0);
  });

  it('requires authentication at all', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alice.workspaceId}/documents`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('gives a MEMBER 403 (not 404) for an owner-only action, because they can see it exists', async () => {
    // Bob joins Alice's workspace as a MEMBER via an invitation.
    const invite = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: alice.cookie },
      payload: { email: 'bob@example.com', role: 'MEMBER' },
    });
    const token = invite.json().inviteUrl.split('/invite/')[1];
    await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: bob.cookie },
      payload: { email: 'carol@example.com' },
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not let a MEMBER delete another person's document", async () => {
    const invite = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: alice.cookie },
      payload: { email: 'bob@example.com', role: 'MEMBER' },
    });
    const token = invite.json().inviteUrl.split('/invite/')[1];
    await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { cookie: bob.cookie },
    });

    // Bob can now see the document...
    const list = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alice.workspaceId}/documents`,
      headers: { cookie: bob.cookie },
    });
    expect(list.json().documents).toHaveLength(1);

    // ...but cannot delete it, because Alice uploaded it.
    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${aliceDocId}`,
      headers: { cookie: bob.cookie },
    });
    expect(remove.statusCode).toBe(403);
  });
});
