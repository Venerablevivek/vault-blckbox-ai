import { createServer, type Server } from 'node:http';
import client from '@prometheus-io/client';
import type { Pool } from 'pg';

/**
 * Prometheus metrics for one process (the API or the worker). Module-level, because a metric may
 * be registered only once per registry; the sources read at scrape time (pools, the queue) are
 * attached by whoever owns them.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'vault_' });

export const httpDuration = new client.Histogram({
  name: 'vault_http_request_duration_seconds',
  help: 'HTTP requests by route template (never the raw URL), method and status.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpInFlight = new client.Gauge({
  name: 'vault_http_requests_in_flight',
  help: 'Requests being handled right now.',
  registers: [registry],
});

export const jobDuration = new client.Histogram({
  name: 'vault_job_duration_seconds',
  help: 'Background jobs by queue and outcome (done, retry, failed).',
  labelNames: ['queue', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [registry],
});

export const webhookDeliveries = new client.Counter({
  name: 'vault_webhook_deliveries_total',
  help: 'Webhook delivery attempts, by whether the receiver accepted them.',
  labelNames: ['success'] as const,
  registers: [registry],
});

const pools = new Map<string, Pool>();
/** Pool usage is read when Prometheus scrapes. */
export function watchPools(named: Record<string, Pool>): void {
  for (const [name, pool] of Object.entries(named)) pools.set(name, pool);
}

new client.Gauge({
  name: 'vault_db_pool_connections',
  help: 'Database pool connections by pool and state (total, idle, waiting clients).',
  labelNames: ['pool', 'state'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const [name, pool] of pools) {
      this.set({ pool: name, state: 'total' }, pool.totalCount);
      this.set({ pool: name, state: 'idle' }, pool.idleCount);
      this.set({ pool: name, state: 'waiting' }, pool.waitingCount);
    }
  },
});

let queuePool: Pool | null = null;
/** Queue depth is read from the jobs table when Prometheus scrapes. */
export function watchQueue(pool: Pool): void {
  queuePool = pool;
}

new client.Gauge({
  name: 'vault_jobs',
  help: 'Jobs waiting or running, by queue and status.',
  labelNames: ['queue', 'status'] as const,
  registers: [registry],
  async collect() {
    if (!queuePool) return;
    const { rows } = await queuePool.query<{ queue: string; status: string; n: string }>(
      `SELECT queue, status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY queue, status`,
    );
    this.reset();
    for (const row of rows) this.set({ queue: row.queue, status: row.status }, Number(row.n));
  },
});

/**
 * Serves /metrics on its own port. Not the API port: metrics describe the system and must not be
 * reachable from the internet, and the public web origin only forwards /api/*.
 */
export function startMetricsServer(
  port: number,
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  host = '0.0.0.0',
): Server {
  const server = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => response.writeHead(200, { 'Content-Type': registry.contentType }).end(body),
      () => response.writeHead(500).end(),
    );
  });
  // A busy port (the API and worker on one machine in development) costs the metrics, not the process.
  server.on('error', (error) => logger.warn({ err: error, port }, 'metrics server not started'));
  server.listen(port, host, () => logger.info({ port }, 'metrics on /metrics'));
  return server;
}
