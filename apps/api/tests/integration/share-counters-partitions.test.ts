import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

/**
 * Link activity is read from counters kept on the link, and the raw history is partitioned by
 * month. These tests check the counters always agree with the history, stay right under
 * concurrency, and that partitions are created and dropped as time passes.
 */
describe('share counters and event partitions', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<typeof registerUser>>;
  let documentId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
    documentId = (await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'contract.pdf')).json().document.id;
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const from = (ip: string) => ({ 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (test)' });

  async function share(payload: Record<string, unknown> = {}) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId, ...payload },
    });
    const body = response.json().share;
    return { id: body.id as string, token: (body.url as string).split('/s/')[1]! };
  }

  const view = (token: string, ip: string) =>
    h.app.inject({ method: 'POST', url: `/api/shares/${token}/view`, headers: from(ip) });
  const download = (token: string, ip: string) =>
    h.app.inject({ method: 'GET', url: `/api/shares/${token}/download`, headers: from(ip) });

  /** What the history says, computed the slow way. */
  async function fromHistory(shareId: string) {
    const [row] = await h.query<{
      opens: string;
      viewers: string;
      blocked: string;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `SELECT COUNT(*) FILTER (WHERE outcome = 'resolved') AS opens,
              COUNT(DISTINCT ip_hash) FILTER (WHERE outcome IN ('resolved','downloaded')) AS viewers,
              COUNT(*) FILTER (WHERE outcome NOT IN ('resolved','downloaded')) AS blocked,
              MIN(accessed_at) FILTER (WHERE outcome IN ('resolved','downloaded')) AS first_at,
              MAX(accessed_at) FILTER (WHERE outcome IN ('resolved','downloaded')) AS last_at
         FROM share_access_events WHERE share_id = $1`,
      [shareId],
    );
    return {
      opens: Number(row!.opens),
      distinctViewers: Number(row!.viewers),
      blockedAttempts: Number(row!.blocked),
      firstAccessedAt: row!.first_at?.toISOString() ?? null,
      lastAccessedAt: row!.last_at?.toISOString() ?? null,
    };
  }

  async function reported() {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/shares`,
      headers: { cookie: alice.cookie },
    });
    return response.json().shares[0].activity;
  }

  it('keeps counters identical to the event history through mixed traffic', async () => {
    const { id, token } = await share({ password: 'open-sesame', maxDownloads: 3 });

    // Wrong passwords are blocked attempts; unlock, then views, repeats, downloads, new viewers.
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      await h.app.inject({
        method: 'POST',
        url: `/api/shares/${token}/unlock`,
        headers: from(ip),
        payload: { password: 'nope' },
      });
    }
    const unlocked = await h.app.inject({
      method: 'POST',
      url: `/api/shares/${token}/unlock`,
      headers: from('203.0.113.1'),
      payload: { password: 'open-sesame' },
    });
    const grant = String(([] as string[]).concat(unlocked.headers['set-cookie'] as string)[0]).split(';')[0]!;
    const withGrant = (ip: string) => ({ ...from(ip), cookie: grant });

    for (const ip of ['203.0.113.1', '203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view`, headers: withGrant(ip) });
      await settle();
    }
    h.clock.advanceHours(1);
    await h.app.inject({ method: 'POST', url: `/api/shares/${token}/view`, headers: withGrant('203.0.113.1') });
    for (const ip of ['203.0.113.4', '203.0.113.1', '203.0.113.5', '203.0.113.6']) {
      await h.app.inject({ method: 'GET', url: `/api/shares/${token}/download`, headers: withGrant(ip) });
      await settle();
    }

    const counters = await reported();
    const history = await fromHistory(id);
    expect(counters).toMatchObject(history);
    expect(counters).toMatchObject({ opens: 4, distinctViewers: 5, downloads: 3 });
    // The 4th download attempt was refused (limit 3) and recorded as blocked.
    expect(counters.blockedAttempts).toBe(3);
  });

  it('counts two simultaneous refreshes by the same viewer once', async () => {
    const { id, token } = await share();
    await Promise.all(Array.from({ length: 8 }, () => view(token, '198.51.100.9')));
    await settle();
    await settle();
    expect(await reported()).toMatchObject({ opens: 1, distinctViewers: 1 });
    expect((await fromHistory(id)).opens).toBe(1);
  });

  it('counts a viewer who only downloads, and does not count them twice when they later view', async () => {
    const { token } = await share();
    await download(token, '198.51.100.20');
    await settle();
    await view(token, '198.51.100.20');
    await settle();
    expect(await reported()).toMatchObject({ opens: 1, downloads: 1, distinctViewers: 1 });
  });

  it('shows opens in the document list from the counters, for live links only', async () => {
    const first = await share();
    const second = await share();
    await view(first.token, '198.51.100.30');
    await view(second.token, '198.51.100.31');
    await settle();
    const list = async () =>
      (
        await h.app.inject({
          method: 'GET',
          url: `/api/workspaces/${alice.workspaceId}/documents`,
          headers: { cookie: alice.cookie },
        })
      ).json().documents[0].links;
    expect(await list()).toMatchObject({ count: 2, opens: 2 });

    await h.app.inject({ method: 'DELETE', url: `/api/shares/${second.id}`, headers: { cookie: alice.cookie } });
    expect(await list()).toMatchObject({ count: 1, opens: 1 });
  });

  it('writes events into the right monthly partition, creating it when a new month starts', async () => {
    const { token } = await share();
    await view(token, '198.51.100.40');
    await settle();
    h.clock.advanceHours(24 * 45);
    await view(token, '198.51.100.40');
    await settle();

    const rows = await h.query<{ partition: string }>(
      `SELECT tableoid::regclass::text AS partition FROM share_access_events ORDER BY accessed_at`,
    );
    expect(rows.map((r) => r.partition)).toEqual(['share_access_events_2026_01', 'share_access_events_2026_02']);
  });

  it('creates partitions ahead and drops whole months past retention', async () => {
    const { token } = await share();
    await view(token, '198.51.100.50');
    await settle();

    // Fourteen months later, January 2026 is past the 13-month retention.
    h.clock.advanceHours(24 * 30.5 * 14);
    const result = await h.app.maintenance.runOnce();
    expect(result!.droppedEventPartitions).toContain('share_access_events_2026_01');

    const partitions = await h.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'share_access_events' ORDER BY 1`,
    );
    const names = partitions.map((p) => p.name);
    expect(names).not.toContain('share_access_events_2026_01');
    const now = h.clock.now();
    for (let ahead = 0; ahead <= 3; ahead++) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
      expect(names).toContain(
        `share_access_events_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`,
      );
    }
    // Counters on the link survive the history being dropped. (Fourteen months also expired the
    // session, so sign in again.)
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'alice@example.com', password: 'password123' },
    });
    alice.cookie = String(([] as string[]).concat(login.headers['set-cookie'] as string)[0]).split(';')[0]!;
    expect(await reported()).toMatchObject({ opens: 1, distinctViewers: 1 });
  });

  it('returns tab counts on the first page only', async () => {
    for (let i = 0; i < 3; i++) {
      await uploadDocument(
        h.app,
        alice.cookie,
        alice.workspaceId,
        `file-${i}.pdf`,
        Buffer.from(`%PDF-1.4\n${i}\n%%EOF\n`),
      );
    }
    const first = (
      await h.app.inject({
        method: 'GET',
        url: `/api/workspaces/${alice.workspaceId}/documents?limit=2`,
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(first.counts).toMatchObject({ all: 4 });
    const second = (
      await h.app.inject({
        method: 'GET',
        url: `/api/workspaces/${alice.workspaceId}/documents?limit=2&cursor=${first.nextCursor}`,
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(second.counts).toBeNull();
    expect(second.documents).toHaveLength(2);
  });
});
