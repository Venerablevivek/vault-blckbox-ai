import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/modules/audit/audit-chain';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/** The audit trail is a hash chain per workspace; these tests tamper with it as the database owner. */
describe('tamper-evident audit trail', () => {
  let h: Harness;
  let alice: User;

  beforeAll(async () => {
    h = await createHarness({ worker: false });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
      await uploadDocument(h.app, alice.cookie, alice.workspaceId, name, Buffer.from(`%PDF-1.4\n${name}\n%%EOF\n`));
    }
  });

  const verify = async (user = alice) =>
    h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alice.workspaceId}/audit/verify`,
      headers: { cookie: user.cookie },
    });
  const events = () =>
    h.query<{ id: string; seq: string }>('SELECT id, seq FROM audit_events WHERE workspace_id = $1 ORDER BY seq', [
      alice.workspaceId,
    ]);

  it('verifies an untouched chain and reports its head', async () => {
    const response = await verify();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ valid: true, legacyEvents: 0, chainedEvents: 4, brokenAt: null });
    const all = await events();
    expect(body.head.eventId).toBe(all[all.length - 1]!.id);
    expect(body.head.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects an event whose content was changed', async () => {
    const [, second] = await events();
    await h.query(
      `UPDATE audit_events SET metadata = jsonb_set(metadata, '{filename}', '"innocent.pdf"') WHERE id = $1`,
      [second!.id],
    );
    const body = (await verify()).json();
    expect(body.valid).toBe(false);
    expect(body.brokenAt).toEqual({
      eventId: second!.id,
      reason: 'content does not match its hash (the event was changed)',
    });
  });

  it('detects an event removed from the middle', async () => {
    const all = await events();
    await h.query('DELETE FROM audit_events WHERE id = $1', [all[1]!.id]);
    const body = (await verify()).json();
    expect(body.valid).toBe(false);
    expect(body.brokenAt.eventId).toBe(all[2]!.id);
    expect(body.brokenAt.reason).toMatch(/removed or inserted/);
  });

  it('detects an actor being rewritten', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
    const [first] = await events();
    await h.query('UPDATE audit_events SET actor_user_id = $1 WHERE id = $2', [bob.userId, first!.id]);
    expect((await verify()).json().brokenAt.eventId).toBe(first!.id);
  });

  it('keeps one unbroken chain under concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        uploadDocument(
          h.app,
          alice.cookie,
          alice.workspaceId,
          `parallel-${i}.pdf`,
          Buffer.from(`%PDF-1.4\n${i}\n%%EOF\n`),
        ),
      ),
    );
    // Some uploads may be turned away by the concurrent-upload limit; every one that succeeded
    // wrote an event, and all of them must chain.
    const body = (await verify()).json();
    const total = (await events()).length;
    expect(total).toBeGreaterThan(4 + 3);
    expect(body).toMatchObject({ valid: true, chainedEvents: total });
  });

  it('counts events from before hashing began, and rejects unhashed events after it', async () => {
    const all = await events();
    // Simulate history recorded before the migration: the oldest event has no hash.
    await h.query('UPDATE audit_events SET hash = NULL, prev_hash = NULL WHERE id = $1', [all[0]!.id]);
    await h.query('UPDATE audit_events SET prev_hash = NULL WHERE id = $1', [all[1]!.id]);
    // The event after it now starts the chain, but its hash was computed over a predecessor.
    const body = (await verify()).json();
    expect(body.legacyEvents).toBe(1);
    expect(body.valid).toBe(false);

    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const [, last] = await events();
    await h.query('UPDATE audit_events SET hash = NULL WHERE id = $1', [last!.id]);
    expect((await verify()).json().brokenAt.reason).toBe('event without a hash after the chain began');
  });

  it('is owner-only', async () => {
    const bob = await registerUser(h.app, 'bob@example.com');
    expect((await verify(bob)).statusCode).toBe(404);
  });

  it('hashes metadata independently of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });
});
