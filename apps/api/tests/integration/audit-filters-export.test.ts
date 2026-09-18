import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/** Parses the CSV the API writes (quoted cells, doubled quotes, CRLF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  return rows;
}

describe('activity filters and CSV exports', () => {
  let h: Harness;
  let owner: User;
  let member: User;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  const call = (user: User | undefined, method: string, url: string, payload?: object) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: user ? { cookie: user.cookie } : {},
      ...(payload ? { payload } : {}),
    });

  const audit = (query: string, as: User = owner) =>
    call(as, 'GET', `/api/workspaces/${owner.workspaceId}/audit?${query}`);
  const actions = async (query: string) =>
    ((await audit(query)).json().events as Array<{ action: string }>).map((e) => e.action);

  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    member = await registerUser(h.app, 'member@example.com');
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'member@example.com',
    });
    await call(member, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
  });

  it('filters by kind of event, action, person, resource and time', async () => {
    const mine = (await uploadDocument(h.app, owner.cookie, owner.workspaceId, 'owner.pdf')).json().document.id;
    h.clock.advanceHours(2);
    const theirs = (await uploadDocument(h.app, member.cookie, owner.workspaceId, 'member.pdf')).json().document.id;
    await call(owner, 'POST', '/api/shares', { documentId: mine });
    await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'Board' });

    expect(await actions('category=document')).toEqual(['document.uploaded', 'document.uploaded']);
    expect(await actions('category=share')).toEqual(['share.created']);
    expect(await actions('category=folder')).toEqual(['folder.created']);
    expect((await actions('category=people')).sort()).toEqual(['member.invited', 'member.joined', 'workspace.created']);
    expect(await actions('action=share.created')).toEqual(['share.created']);

    const byMember = (await audit(`actorId=${member.userId}`)).json().events;
    expect(byMember.map((e: { action: string }) => e.action)).toEqual(['document.uploaded', 'member.joined']);
    expect((await audit(`resourceId=${theirs}`)).json().events).toHaveLength(1);
    expect((await audit(`resourceId=${mine}`)).json().events).toHaveLength(1);

    // The time window: only what happened after the clock moved on.
    const after = new Date(Date.parse('2026-01-01T12:00:00Z') + 60 * 60 * 1000).toISOString();
    expect(await actions(`category=document&from=${after}`)).toEqual(['document.uploaded']);
    expect(await actions(`category=document&to=${after}`)).toEqual(['document.uploaded']);

    expect((await audit('category=everything')).statusCode).toBe(400);
    expect((await audit('action=document.exploded')).statusCode).toBe(400);
  });

  it('pages with a cursor that never skips or repeats events, even when they share a timestamp', async () => {
    // The test clock is frozen: every one of these has the same created_at.
    for (let i = 0; i < 7; i += 1)
      await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: `F${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { events: Array<{ id: string }>; nextCursor: string | null } = (
        await audit(`category=folder&limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      ).json();
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('exports the filtered trail as CSV, safe to open in a spreadsheet', async () => {
    // Names a spreadsheet would misread, set by renaming (a multipart header can't carry quotes).
    const rename = async (filename: string) => {
      const id = (await uploadDocument(h.app, owner.cookie, owner.workspaceId, 'x.pdf')).json().document.id;
      expect((await call(owner, 'PATCH', `/api/documents/${id}`, { filename })).statusCode).toBe(200);
    };
    await rename('=HYPERLINK("http://evil.example","x").pdf');
    await rename('plain, with "quotes".pdf');

    const res = await call(owner, 'GET', `/api/workspaces/${owner.workspaceId}/audit/export?action=document.renamed`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="activity-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.body.charCodeAt(0)).toBe(0xfeff);

    const rows = parseCsv(res.body.slice(1));
    expect(rows[0]).toEqual(['time_utc', 'actor', 'action', 'resource_type', 'resource_id', 'file', 'details', 'hash']);
    const files = rows.slice(1).map((r) => r[5]);
    expect(files).toEqual(['plain, with "quotes".pdf', `'=HYPERLINK("http://evil.example","x").pdf`]);
    for (const row of rows.slice(1)) {
      expect(row[1]).toBe('owner@example.com');
      expect(row[2]).toBe('document.renamed');
      expect(row[7]).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(row[6]!)).toMatchObject({ from: 'x.pdf' });
    }
  });

  it('exports trails larger than one batch', async () => {
    await h.query(
      `INSERT INTO audit_events (id, workspace_id, actor_user_id, action, resource_type, metadata, created_at)
       SELECT gen_random_uuid(), $1, $2, 'document.downloaded', 'document', '{"filename": "bulk.pdf"}', now()
         FROM generate_series(1, 1205)`,
      [owner.workspaceId, owner.userId],
    );
    const res = await call(
      owner,
      'GET',
      `/api/workspaces/${owner.workspaceId}/audit/export?action=document.downloaded`,
    );
    const rows = parseCsv(res.body.slice(1));
    // Two batches of 1000 and one of 205, plus the header: nothing skipped or repeated at the seams.
    expect(rows).toHaveLength(1206);
  });

  it('keeps the trail and its export to owners', async () => {
    for (const path of ['audit', 'audit/export']) {
      expect((await call(member, 'GET', `/api/workspaces/${owner.workspaceId}/${path}`)).statusCode, path).toBe(403);
      const outsider = await registerUser(h.app, `outsider-${path.length}@example.com`);
      expect((await call(outsider, 'GET', `/api/workspaces/${owner.workspaceId}/${path}`)).statusCode, path).toBe(404);
    }
  });

  it("exports a link's access history for members of its workspace", async () => {
    const doc = (await uploadDocument(h.app, owner.cookie, owner.workspaceId, 'r.pdf')).json().document.id;
    const share = await call(owner, 'POST', '/api/shares', { documentId: doc });
    const token = share.json().share.url.split('/s/')[1];
    await call(undefined, 'POST', `/api/shares/${token}/view`);
    await call(undefined, 'GET', `/api/shares/${token}/download`);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const res = await call(member, 'GET', `/api/shares/${share.json().share.id}/events/export`);
    expect(res.statusCode).toBe(200);
    const rows = parseCsv(res.body.slice(1));
    expect(rows[0]).toEqual(['time_utc', 'outcome', 'viewer', 'email', 'user_agent']);
    expect(
      rows
        .slice(1)
        .map((r) => r[1])
        .sort(),
    ).toEqual(['downloaded', 'resolved']);
    expect(rows[1]![2]).toMatch(/^[0-9a-f]{8}$/);

    const outsider = await registerUser(h.app, 'outsider@example.com');
    const denied = await call(outsider, 'GET', `/api/shares/${share.json().share.id}/events/export`);
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('NOT_FOUND');
  });
});
