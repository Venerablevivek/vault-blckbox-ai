import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlockedDestinationError, checkWebhookUrl, isReservedAddress, postJson } from '../../src/lib/safe-http';
import { signPayload } from '../../src/modules/webhooks/webhooks.service';

describe('webhook destinations', () => {
  it('treats private, loopback, link-local and reserved addresses as unreachable', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not-an-ip',
    ]) {
      expect(isReservedAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isReservedAddress(address), address).toBe(false);
    }
  });

  it('only accepts https URLs on public hosts, without credentials', () => {
    expect(checkWebhookUrl('https://hooks.example.com/vault', false).hostname).toBe('hooks.example.com');
    for (const url of [
      'http://hooks.example.com/vault',
      'ftp://hooks.example.com',
      'https://user:pass@hooks.example.com',
      'https://localhost/hook',
      'https://app.localhost/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5:8443/hook',
      'not a url',
    ]) {
      expect(() => checkWebhookUrl(url, false), url).toThrow(BlockedDestinationError);
    }
    // Development and tests may opt in to local, plain-http receivers.
    expect(checkWebhookUrl('http://127.0.0.1:9999/hook', true).port).toBe('9999');
  });

  it('refuses a host name that resolves only to a private address, at connection time', async () => {
    // Passes the URL check (it isn't literally "localhost"), but resolves to loopback.
    await expect(
      postJson('https://localhost./hook', '{}', {}, { allowInsecure: false, timeoutMs: 2000 }),
    ).rejects.toThrow(/private or reserved/);
  });

  it('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex');
    expect(signPayload('whsec_test', '{"a":1}', 1700000000)).toBe(`t=1700000000,v1=${expected}`);
  });
});
