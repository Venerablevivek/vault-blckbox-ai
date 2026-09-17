import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, TEST_PASSWORD, uploadDocument, type Harness } from '../helpers/harness';
import { createSlots } from '../../src/lib/slots';
import type { FileStorage } from '../../src/storage/file-storage';

describe('per-account login lockout', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.truncate());

  const login = (email: string, password: string, ip: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email, password },
    });

  it('locks an account after 5 failures from different addresses, even for the right password', async () => {
    await registerUser(h.app, 'alice@example.com');
    for (let i = 1; i <= h.config.LOGIN_LOCKOUT_ATTEMPTS; i += 1) {
      // A different address each time, so per-IP limits alone would never slow this down.
      expect((await login('alice@example.com', 'wrong-password', `198.51.100.${i}`)).statusCode).toBe(401);
    }
    const locked = await login('alice@example.com', TEST_PASSWORD, '192.0.2.99');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('locks an unknown address exactly the same way, so lockout cannot reveal who has an account', async () => {
    for (let i = 1; i <= h.config.LOGIN_LOCKOUT_ATTEMPTS; i += 1) {
      await login('nobody@example.com', 'wrong-password', `198.51.100.${i}`);
    }
    const locked = await login('nobody@example.com', 'wrong-password', '192.0.2.99');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('unlocks once the window has passed', async () => {
    await registerUser(h.app, 'alice@example.com');
    for (let i = 1; i <= h.config.LOGIN_LOCKOUT_ATTEMPTS; i += 1) {
      await login('alice@example.com', 'wrong-password', '198.51.100.1');
    }
    expect((await login('alice@example.com', TEST_PASSWORD, '198.51.100.1')).statusCode).toBe(429);

    h.clock.advanceHours(h.config.LOGIN_LOCKOUT_MINUTES / 60 + 0.1);
    expect((await login('alice@example.com', TEST_PASSWORD, '198.51.100.1')).statusCode).toBe(200);
  });

  it('clears the failure count after a successful login', async () => {
    await registerUser(h.app, 'alice@example.com');
    for (let i = 1; i < h.config.LOGIN_LOCKOUT_ATTEMPTS; i += 1) {
      await login('alice@example.com', 'wrong-password', '198.51.100.1');
    }
    expect((await login('alice@example.com', TEST_PASSWORD, '198.51.100.1')).statusCode).toBe(200);
    // Counting restarts: one more failure is not enough to lock.
    expect((await login('alice@example.com', 'wrong-password', '198.51.100.1')).statusCode).toBe(401);
    expect((await login('alice@example.com', TEST_PASSWORD, '198.51.100.1')).statusCode).toBe(200);
  });

  it('stores only a hash of the email address', async () => {
    await login('someone@example.com', 'wrong-password', '198.51.100.1');
    const rows = await h.query<{ email_hash: Buffer }>('SELECT email_hash FROM login_failures');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email_hash.toString('utf8')).not.toContain('someone');
  });
});

describe('upload capacity', () => {
  it('slots never hand out more than their capacity', () => {
    const slots = createSlots(2);
    const a = slots.tryAcquire();
    const b = slots.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(slots.tryAcquire()).toBeNull();
    a!();
    a!(); // releasing twice must not free a second slot
    expect(slots.inUse).toBe(1);
    expect(slots.tryAcquire()).not.toBeNull();
  });

  it('turns away uploads beyond the concurrent limit with 503 and Retry-After', async () => {
    let finishUpload: () => void = () => undefined;
    const slowStorage: FileStorage = {
      upload: () => new Promise<void>((resolve) => (finishUpload = resolve)),
      download: async () => Readable.from(Buffer.alloc(0)),
      delete: async () => undefined,
      getSignedUrl: async () => 'http://example.invalid/signed',
    };
    const h = await createHarness({ storage: slowStorage, env: { MAX_CONCURRENT_UPLOADS: '1' } });
    try {
      await h.truncate();
      const alice = await registerUser(h.app, 'alice@example.com');

      const first = uploadDocument(h.app, alice.cookie, alice.workspaceId, 'first.pdf');
      await new Promise((resolve) => setTimeout(resolve, 150)); // let the first take the slot

      const second = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'second.pdf');
      expect(second.statusCode).toBe(503);
      expect(second.json().error.code).toBe('UPLOADS_BUSY');
      expect(second.headers['retry-after']).toBe('5');

      finishUpload();
      expect((await first).statusCode).toBe(201);

      // The slot was released, so the next upload is accepted.
      const third = uploadDocument(h.app, alice.cookie, alice.workspaceId, 'third.pdf');
      await new Promise((resolve) => setTimeout(resolve, 150));
      finishUpload();
      expect((await third).statusCode).toBe(201);
    } finally {
      await h.close();
    }
  });
});
