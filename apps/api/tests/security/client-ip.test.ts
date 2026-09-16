import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

/**
 * X-Forwarded-For is only believed when it comes from a trusted proxy.
 *
 * Before this, the API trusted the header from anyone, so a client could choose its own
 * address on every request: per-IP rate limits never tripped, and share-link viewer counts
 * (and the "may have been forwarded" warning) could be faked at will.
 *
 * The harness injects requests from 127.0.0.1. These tests configure the trusted list so
 * that address is either trusted or not, and observe the outcome through the distinct-viewer
 * count, which is keyed on the resolved client IP.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

async function viewersAfterSpoofedOpens(h: Harness, remoteAddress: string): Promise<number> {
  const alice = await registerUser(h.app, 'alice@example.com');
  const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
  const documentId = upload.json().document.id;
  const share = await h.app.inject({
    method: 'POST',
    url: '/api/shares',
    headers: { cookie: alice.cookie },
    payload: { documentId },
  });
  const token = share.json().share.url.split('/s/')[1];

  for (const spoofed of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
    await h.app.inject({
      method: 'POST',
      url: `/api/shares/${token}/view`,
      remoteAddress,
      headers: { 'x-forwarded-for': spoofed },
    });
  }
  await settle();

  const list = await h.app.inject({
    method: 'GET',
    url: `/api/documents/${documentId}/shares`,
    headers: { cookie: alice.cookie },
  });
  return list.json().shares[0].activity.distinctViewers;
}

describe('client IP resolution', () => {
  describe('with the default trusted list (loopback only)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => h.close());
    beforeEach(async () => h.truncate());

    it('ignores X-Forwarded-For from an untrusted address', async () => {
      // Three different spoofed addresses from one real client: one viewer.
      expect(await viewersAfterSpoofedOpens(h, '198.51.100.20')).toBe(1);
    });

    it('believes X-Forwarded-For from a trusted proxy', async () => {
      expect(await viewersAfterSpoofedOpens(h, '127.0.0.1')).toBe(3);
    });
  });

  describe('with an explicit proxy address', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness({ env: { TRUSTED_PROXIES: '10.203.14.10' } });
    });
    afterAll(async () => h.close());
    beforeEach(async () => h.truncate());

    it('stops trusting loopback once a specific proxy is configured', async () => {
      expect(await viewersAfterSpoofedOpens(h, '127.0.0.1')).toBe(1);
    });

    it('trusts only the configured proxy', async () => {
      expect(await viewersAfterSpoofedOpens(h, '10.203.14.10')).toBe(3);
    });
  });
});
