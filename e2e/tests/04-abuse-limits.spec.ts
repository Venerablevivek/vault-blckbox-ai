import { expect, test } from '@playwright/test';
import { uniqueEmail } from './helpers';

/**
 * Runs last: it uses up the login rate limit for this client address.
 *
 * Every request goes through the web server, the way a browser reaches the API, and each
 * one claims a different address in X-Forwarded-For. Neither limit may be dodged that way.
 */
test.describe.serial('brute-force protection', () => {
  const spoofed = (i: number) => ({ 'X-Forwarded-For': `198.51.100.${(i % 250) + 1}` });

  test('an account locks after repeated wrong passwords, from any address', async ({ request }) => {
    const email = uniqueEmail('target');
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await request.post('/api/auth/login', {
        headers: spoofed(i),
        data: { email, password: `wrong-password-${i}` },
      });
      codes.push(`${response.status()}:${((await response.json()) as { error: { code: string } }).error.code}`);
    }
    expect(codes.slice(0, 5).every((c) => c.startsWith('401:'))).toBe(true);
    expect(codes[5]).toBe('429:ACCOUNT_LOCKED');
  });

  test('the per-address login limit ignores a spoofed X-Forwarded-For', async ({ request }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const response = await request.post('/api/auth/login', {
        headers: spoofed(i + 10),
        data: { email: uniqueEmail('spray'), password: 'wrong-password' },
      });
      statuses.push(response.status());
    }
    const firstLimited = statuses.indexOf(429);
    expect(firstLimited, `statuses: ${statuses.join(',')}`).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(firstLimited).every((s) => s === 429)).toBe(true);
  });
});
