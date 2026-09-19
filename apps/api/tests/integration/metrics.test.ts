import type { AddressInfo } from 'node:net';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry, startMetricsServer } from '../../src/observability/metrics';
import { RedactingSpanProcessor } from '../../src/observability/tracing';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

const quiet = { info: () => undefined, warn: () => undefined };

describe('metrics', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ worker: false });
  });
  afterAll(async () => h.close());

  it('times requests by route template, never by the raw URL', async () => {
    await h.truncate();
    const alice = await registerUser(h.app, 'alice@example.com');
    await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alice.workspaceId}/documents`,
      headers: { cookie: alice.cookie },
    });
    await h.app.inject({ method: 'GET', url: '/api/shares/shr_notarealtokenbutlongenough00000000' });

    const text = await registry.metrics();
    expect(text).toMatch(
      /vault_http_request_duration_seconds_count\{method="GET",route="\/api\/workspaces\/:workspaceId\/documents",status_code="200"\} [1-9]/,
    );
    expect(text).toMatch(/route="\/api\/shares\/:token",status_code="404"/);
    // Neither ids nor tokens become label values.
    expect(text).not.toContain(alice.workspaceId);
    expect(text).not.toContain('shr_');
    expect(text).toMatch(/vault_http_requests_in_flight 0/);
  });

  it('reports queue depth, job timings and pool usage', async () => {
    await h.truncate();
    const alice = await registerUser(h.app, 'alice@example.com');
    await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'a.pdf');
    let text = await registry.metrics();
    expect(text).toMatch(/vault_jobs\{queue="document\.process",status="queued"\} 1/);

    await h.runJobs();
    text = await registry.metrics();
    expect(text).not.toMatch(/vault_jobs\{queue="document\.process"/);
    expect(text).toMatch(/vault_job_duration_seconds_count\{queue="document\.process",outcome="done"\} [1-9]/);
    expect(text).toMatch(/vault_db_pool_connections\{pool="main",state="total"\} \d+/);
    expect(text).toMatch(/vault_process_cpu_user_seconds_total/);
  });

  it('serves /metrics on its own port, and nothing else', async () => {
    const server = startMetricsServer(0, quiet, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await metrics.text()).toContain('vault_http_request_duration_seconds');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('tracing', () => {
  it('removes tokens from span names and attributes before export', () => {
    const span = {
      name: 'GET /api/shares/shr_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
      attributes: {
        'url.path': '/api/shares/shr_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF/download',
        'http.target': '/f/fsh_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
        'http.status_code': 200,
      },
    } as unknown as ReadableSpan;
    new RedactingSpanProcessor().onEnd(span);
    expect(span.name).toBe('GET /api/shares/shr_[REDACTED]');
    expect(span.attributes).toEqual({
      'url.path': '/api/shares/shr_[REDACTED]/download',
      'http.target': '/f/fsh_[REDACTED]',
      'http.status_code': 200,
    });
  });
});
