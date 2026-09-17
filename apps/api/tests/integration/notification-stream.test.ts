import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STREAMS_PER_USER } from '../../src/modules/notifications/notifications.routes';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/** A minimal server-sent events reader over fetch, collecting event names as they arrive. */
function openStream(baseUrl: string, cookie: string) {
  const controller = new AbortController();
  const events: string[] = [];
  let finished = false;
  const ready = fetch(`${baseUrl}/api/notifications/stream`, { headers: { cookie }, signal: controller.signal }).then(
    async (response) => {
      if (response.status !== 200) return response;
      void (async () => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const name = /^event: (.+)$/m.exec(block)?.[1];
              events.push(name ?? (block.startsWith(':') ? 'comment' : 'other'));
            }
          }
        } catch {
          // aborted
        } finally {
          finished = true;
        }
      })();
      return response;
    },
  );
  return {
    ready,
    events,
    isFinished: () => finished,
    close: () => controller.abort(),
    async waitFor(name: string, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!events.includes(name)) {
        if (Date.now() > deadline) throw new Error(`no "${name}" event; got ${JSON.stringify(events)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

describe('notification stream', () => {
  let h: Harness;
  let baseUrl: string;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    h = await createHarness({ env: { NOTIFICATION_STREAM_HEARTBEAT_SECONDS: '1' } });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => h.close());

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
    await h.drainJobs();
  });

  it('pushes an event the moment a notification is created', async () => {
    const stream = openStream(baseUrl, bob.cookie);
    const response = await stream.ready;
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    await stream.waitFor('ready');

    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'deck.pdf');
    await stream.waitFor('notification');
    stream.close();
  });

  it("does not send one person's notifications to another", async () => {
    const aliceStream = openStream(baseUrl, alice.cookie);
    await aliceStream.ready;
    await aliceStream.waitFor('ready');

    // Alice uploads: Bob is notified, Alice is not.
    const bobStream = openStream(baseUrl, bob.cookie);
    await bobStream.waitFor('ready');
    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'plan.pdf');
    await bobStream.waitFor('notification');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(aliceStream.events).not.toContain('notification');
    aliceStream.close();
    bobStream.close();
  });

  it('requires a session', async () => {
    const response = await fetch(`${baseUrl}/api/notifications/stream`);
    expect(response.status).toBe(401);
  });

  it('ends the stream once its session is signed out elsewhere', async () => {
    const stream = openStream(baseUrl, bob.cookie);
    await stream.waitFor('ready');
    await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: bob.cookie } });
    const deadline = Date.now() + 4000;
    while (!stream.isFinished() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.isFinished()).toBe(true);
  });

  it('sends keep-alive comments', async () => {
    const stream = openStream(baseUrl, bob.cookie);
    await stream.waitFor('ready');
    await stream.waitFor('comment', 3000);
    stream.close();
  });

  it(`limits one person to ${MAX_STREAMS_PER_USER} open streams`, async () => {
    const streams = Array.from({ length: MAX_STREAMS_PER_USER }, () => openStream(baseUrl, bob.cookie));
    for (const stream of streams) await stream.waitFor('ready');
    const extra = await fetch(`${baseUrl}/api/notifications/stream`, { headers: { cookie: bob.cookie } });
    expect(extra.status).toBe(429);
    expect(((await extra.json()) as { error: { code: string } }).error.code).toBe('STREAM_LIMIT');
    streams.forEach((stream) => stream.close());
  });
});
