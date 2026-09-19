import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('webhooks', () => {
  let h: Harness;
  let owner: User;
  let receiver: Server;
  let endpoint: string;
  const received: Received[] = [];
  /** Status codes to answer with, in order; 200 once they run out. */
  const replies: number[] = [];

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(replies.shift() ?? 200).end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    // Jobs are run by hand, so each delivery attempt happens exactly when the test says.
    h = await createHarness({ env: { WEBHOOK_ALLOW_INSECURE: 'true' }, worker: false });
  });
  afterAll(async () => {
    await h.close();
    await new Promise((resolve) => receiver.close(resolve));
  });
  beforeEach(async () => {
    await h.truncate();
    received.length = 0;
    replies.length = 0;
    owner = await registerUser(h.app, 'owner@example.com');
  });

  const call = (user: User, method: string, url: string, payload?: object) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie: user.cookie }, ...(payload ? { payload } : {}) });
  const hooks = (path = '') => `/api/workspaces/${owner.workspaceId}/webhooks${path}`;

  async function addWebhook(events: string[]) {
    const res = await call(owner, 'POST', hooks(), { url: endpoint, events });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  it('POSTs subscribed events, signed with the secret, and nothing else', async () => {
    const { webhook, secret } = await addWebhook(['document.uploaded']);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);

    const doc = (await uploadDocument(h.app, owner.cookie, owner.workspaceId, 'plan.pdf')).json().document;
    await call(owner, 'POST', '/api/shares', { documentId: doc.id }); // share.created: not subscribed
    await h.runJobs();

    expect(received).toHaveLength(1);
    const [delivery] = received;
    const payload = JSON.parse(delivery!.body);
    expect(payload).toMatchObject({
      type: 'document.uploaded',
      workspaceId: owner.workspaceId,
      actor: { id: owner.userId, email: 'owner@example.com' },
      resource: { type: 'document', id: doc.id },
      data: { filename: 'plan.pdf' },
    });
    expect(delivery!.headers['vault-event']).toBe('document.uploaded');
    expect(delivery!.headers['vault-delivery']).toBe(payload.id);
    expect(delivery!.headers['user-agent']).toBe('Vault-Webhooks/1.0');

    // What a receiver does: recompute the signature over "<t>.<raw body>".
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(delivery!.headers['vault-signature']))!;
    const expected = createHmac('sha256', secret).update(`${t}.${delivery!.body}`).digest();
    expect(timingSafeEqual(expected, Buffer.from(v1!, 'hex'))).toBe(true);

    const log = (await call(owner, 'GET', hooks(`/${webhook.id}/deliveries`))).json().deliveries;
    expect(log).toMatchObject([{ eventType: 'document.uploaded', success: true, statusCode: 200 }]);
  });

  it('retries a failing receiver with backoff until it succeeds', async () => {
    const { webhook } = await addWebhook(['folder.created']);
    replies.push(500, 503);
    await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'Board' });
    await h.runJobs();
    expect(received).toHaveLength(1);
    for (let i = 0; i < 2; i += 1) {
      h.clock.advanceHours(1);
      await h.runJobs();
    }
    expect(received).toHaveLength(3);
    const log = (await call(owner, 'GET', hooks(`/${webhook.id}/deliveries`))).json().deliveries;
    expect(log.map((d: { statusCode: number }) => d.statusCode)).toEqual([200, 503, 500]);
    const listed = (await call(owner, 'GET', hooks())).json().webhooks[0];
    expect(listed).toMatchObject({ enabled: true, consecutiveFailures: 0, lastStatus: 200 });
  });

  it('switches itself off after too many failures in a row, and can be switched back on', async () => {
    const { webhook } = await addWebhook(['folder.created']);
    await h.query('UPDATE webhooks SET consecutive_failures = 14');
    replies.push(500);
    await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'A' });
    await h.runJobs();
    let listed = (await call(owner, 'GET', hooks())).json().webhooks[0];
    expect(listed).toMatchObject({ enabled: false, disabledReason: 'too many failed deliveries in a row' });

    // Off: no more deliveries are even queued.
    await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'B' });
    h.clock.advanceHours(2);
    await h.runJobs();
    expect(received).toHaveLength(1);

    listed = (await call(owner, 'PATCH', hooks(`/${webhook.id}`), { enabled: true })).json().webhook;
    expect(listed).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null });
    await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'C' });
    await h.runJobs();
    expect(received).toHaveLength(2);
  });

  it('sends a test ping on request, and stops for good once removed', async () => {
    const { webhook } = await addWebhook(['folder.created']);
    const ping = await call(owner, 'POST', hooks(`/${webhook.id}/ping`));
    expect(ping.json()).toEqual({ success: true, statusCode: 200, error: null });
    expect(JSON.parse(received[0]!.body).type).toBe('webhook.ping');

    expect((await call(owner, 'DELETE', hooks(`/${webhook.id}`))).statusCode).toBe(204);
    await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/folders`, { name: 'After' });
    await h.runJobs();
    expect(received).toHaveLength(1);
    const audit = await h.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_type = 'webhook' ORDER BY seq`,
    );
    expect(audit.map((a) => a.action)).toEqual(['webhook.created', 'webhook.deleted']);
  });

  it('is managed by owners only, and bounded', async () => {
    const member = await registerUser(h.app, 'member@example.com');
    const invite = await call(owner, 'POST', `/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'member@example.com',
    });
    await call(member, 'POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`);
    expect((await call(member, 'GET', hooks())).statusCode).toBe(403);
    expect((await call(member, 'POST', hooks(), { url: endpoint, events: ['folder.created'] })).statusCode).toBe(403);
    const outsider = await registerUser(h.app, 'outsider@example.com');
    expect((await call(outsider, 'GET', hooks())).statusCode).toBe(404);

    for (let i = 0; i < 10; i += 1) await addWebhook(['folder.created']);
    expect((await call(owner, 'POST', hooks(), { url: endpoint, events: ['folder.created'] })).statusCode).toBe(409);
    expect((await call(owner, 'POST', hooks(), { url: endpoint, events: ['folder.exploded'] })).statusCode).toBe(400);
    expect((await call(owner, 'POST', hooks(), { url: endpoint, events: [] })).statusCode).toBe(400);
  });
});

describe('webhook destinations in production settings', () => {
  let h: Harness;
  let owner: User;
  beforeAll(async () => {
    h = await createHarness({ worker: false });
  });
  afterAll(async () => h.close());

  it('refuses plain http and anything that is not a public address', async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
    const add = (url: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/workspaces/${owner.workspaceId}/webhooks`,
        headers: { cookie: owner.cookie },
        payload: { url, events: ['folder.created'] },
      });
    for (const url of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.0.10/x',
    ]) {
      const res = await add(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('INVALID_WEBHOOK_URL');
    }
    // A name that only resolves to a private address is accepted as a URL, but refused on delivery.
    const sneaky = await add('https://localhost./x');
    expect(sneaky.statusCode).toBe(201);
    const ping = await h.app.inject({
      method: 'POST',
      url: `/api/workspaces/${owner.workspaceId}/webhooks/${sneaky.json().webhook.id}/ping`,
      headers: { cookie: owner.cookie },
    });
    expect(ping.json()).toMatchObject({
      success: false,
      statusCode: null,
      error: expect.stringMatching(/private or reserved/),
    });
  });
});
