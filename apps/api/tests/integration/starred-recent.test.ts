import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

describe('starred and recent documents', () => {
  let h: Harness;
  let alice: User;
  let bob: User;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (method: string, url: string, user: User) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie: user.cookie } });
  const list = async (user: User, query: string) =>
    (await call('GET', `/api/workspaces/${alice.workspaceId}/documents?${query}`, user)).json();

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    bob = await registerUser(h.app, 'bob@example.com');
    const invite = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${alice.workspaceId}/invitations`,
      headers: { cookie: alice.cookie },
      payload: { email: 'bob@example.com' },
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`,
      headers: { cookie: bob.cookie },
    });
    const folder = (
      await h.app.inject({
        method: 'POST',
        url: `/api/workspaces/${alice.workspaceId}/folders`,
        headers: { cookie: alice.cookie },
        payload: { name: 'Nested' },
      })
    ).json().folder;
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
      ids[name] = (
        await uploadDocument(h.app, alice.cookie, alice.workspaceId, name, Buffer.from(`%PDF-1.4\n${name}\n%%EOF\n`))
      ).json().document.id;
    }
    // c.pdf lives in a folder: filters must still find it from the root.
    await h.app.inject({
      method: 'PATCH',
      url: `/api/documents/${ids['c.pdf']}`,
      headers: { cookie: alice.cookie },
      payload: { folderId: folder.id },
    });
  });

  it('stars are personal: counted, listed and flagged for the person who starred', async () => {
    expect((await call('PUT', `/api/documents/${ids['a.pdf']}/star`, bob)).statusCode).toBe(204);
    expect((await call('PUT', `/api/documents/${ids['c.pdf']}/star`, bob)).statusCode).toBe(204);
    // Starring twice is harmless.
    expect((await call('PUT', `/api/documents/${ids['a.pdf']}/star`, bob)).statusCode).toBe(204);

    const bobs = await list(bob, 'filter=starred');
    expect(bobs.documents.map((d: { filename: string }) => d.filename).sort()).toEqual(['a.pdf', 'c.pdf']);
    expect(bobs.counts.starred).toBe(2);
    expect(bobs.documents.every((d: { starred: boolean }) => d.starred)).toBe(true);

    const alices = await list(alice, 'filter=starred');
    expect(alices.documents).toHaveLength(0);
    expect((await list(alice, '')).documents.every((d: { starred: boolean }) => !d.starred)).toBe(true);

    await call('DELETE', `/api/documents/${ids['a.pdf']}/star`, bob);
    expect((await list(bob, 'filter=starred')).counts.starred).toBe(1);
  });

  it("can't star a document outside your workspaces", async () => {
    const eve = await registerUser(h.app, 'eve@example.com');
    expect((await call('PUT', `/api/documents/${ids['a.pdf']}/star`, eve)).statusCode).toBe(404);
  });

  it('lists recently opened documents, most recent first, per person', async () => {
    await call('GET', `/api/documents/${ids['b.pdf']}/download`, bob);
    h.clock.advanceHours(1);
    await call('GET', `/api/documents/${ids['c.pdf']}/preview`, bob);
    // "Recent" is recorded after the response: wait for it rather than a fixed time.
    await expect
      .poll(async () => (await list(bob, 'filter=recent')).documents.map((d: { filename: string }) => d.filename))
      .toEqual(['c.pdf', 'b.pdf']);
    // Alice uploaded all three, which counts as opening them.
    expect((await list(alice, 'filter=recent')).documents).toHaveLength(3);
  });

  it('finds documents inside folders from the Shared and Mine tabs, matching their counts', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId: ids['c.pdf'] },
    });
    const shared = await list(alice, 'filter=shared');
    expect(shared.documents.map((d: { filename: string }) => d.filename)).toEqual(['c.pdf']);
    expect(shared.counts.shared).toBe(1);
    const mine = await list(alice, 'filter=mine');
    expect(mine.documents).toHaveLength(3);
    expect(mine.counts.mine).toBe(3);
    // The plain view is still per folder.
    expect((await list(alice, '')).documents).toHaveLength(2);
  });
});
