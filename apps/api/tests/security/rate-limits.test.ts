import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The per-client rate limits, with counters in PostgreSQL. Requests come from the harness's
 * loopback address, which is a trusted proxy by default, so X-Forwarded-For stands in for
 * different clients the way the web server supplies them.
 */
describe('rate limits', () => {
  let first: Harness;
  let second: Harness;

  beforeAll(async () => {
    first = await createHarness({ worker: false, env: { RATE_LIMIT_ENABLED: 'true' } });
    // A second API instance on the same database, like a second replica.
    second = await createHarness({ worker: false, env: { RATE_LIMIT_ENABLED: 'true' } });
  });
  afterAll(async () => {
    await first.close();
    await second.close();
  });
  beforeEach(async () => first.truncate());

  const login = (h: Harness, ip: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email: `nobody-${Math.random()}@example.com`, password: 'wrong-password' },
    });

  it('blocks a client after 20 sign-in attempts in 15 minutes, with Retry-After', async () => {
    for (let i = 0; i < 20; i++) expect((await login(first, '203.0.113.10')).statusCode).toBe(401);
    const blocked = await login(first, '203.0.113.10');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(800);
  });

  it('counts each client separately', async () => {
    for (let i = 0; i < 21; i++) await login(first, '203.0.113.20');
    expect((await login(first, '203.0.113.20')).statusCode).toBe(429);
    expect((await login(first, '203.0.113.21')).statusCode).toBe(401);
  });

  it('shares one limit across API instances', async () => {
    for (let i = 0; i < 12; i++) expect((await login(first, '203.0.113.30')).statusCode).toBe(401);
    for (let i = 0; i < 8; i++) expect((await login(second, '203.0.113.30')).statusCode).toBe(401);
    expect((await login(second, '203.0.113.30')).statusCode).toBe(429);
    expect((await login(first, '203.0.113.30')).statusCode).toBe(429);
  });

  it('keeps each route’s limit separate', async () => {
    for (let i = 0; i < 21; i++) await login(first, '203.0.113.40');
    const forgot = await first.app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      headers: { 'x-forwarded-for': '203.0.113.40' },
      payload: { email: 'someone@example.com' },
    });
    expect(forgot.statusCode).toBe(202);
  });

  it('starts a new window once the old one has ended', async () => {
    for (let i = 0; i < 21; i++) await login(first, '203.0.113.50');
    expect((await login(first, '203.0.113.50')).statusCode).toBe(429);
    await first.query(`UPDATE rate_limits SET window_ends_at = now() - interval '1 second'`);
    expect((await login(first, '203.0.113.50')).statusCode).toBe(401);
  });

  it('never stores the client address', async () => {
    await login(first, '203.0.113.60');
    const rows = await first.query<{ key: Buffer }>('SELECT key FROM rate_limits');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key.length).toBe(32);
      expect(row.key.toString('latin1')).not.toContain('203.0.113.60');
    }
  });

  it('removes ended windows in the maintenance pass', async () => {
    await login(first, '203.0.113.70');
    await first.query(`UPDATE rate_limits SET window_ends_at = now() - interval '1 minute'`);
    const result = await first.app.maintenance.runOnce();
    expect(result!.rateLimitRows).toBeGreaterThanOrEqual(1);
    expect(await first.query('SELECT 1 FROM rate_limits')).toHaveLength(0);
  });
});
