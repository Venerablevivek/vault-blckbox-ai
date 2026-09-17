import path from 'node:path';
import { Client, type Pool } from 'pg';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { createPool } from '../../src/db/pool';
import { runMigrations } from '../../src/db/migrate';
import { buildApp } from '../../src/server';
import { S3Storage } from '../../src/storage/s3-storage';
import type { FileStorage } from '../../src/storage/file-storage';
import type { Clock } from '../../src/types';
import { loadConfig, type Config } from '../../src/config';
import { MemoryMailer } from '../../src/mail/mailer';

/**
 * Integration tests run against a REAL PostgreSQL and a REAL MinIO.
 *
 * Mocks would pass while production broke: a fake S3 happily "deletes" an object a real
 * bucket keeps, and a fake database does not enforce the composite primary key that is
 * what actually prevents duplicate membership. The bugs worth catching here live exactly
 * in the gap between the fake and the real thing.
 *
 * Requires `docker compose up -d postgres minio`.
 */
const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = process.env.TEST_PG_PORT ?? '5432';
const PG_USER = process.env.TEST_PG_USER ?? 'filesharing';
const PG_PASSWORD = process.env.TEST_PG_PASSWORD ?? 'filesharing';
const TEST_DB = process.env.TEST_PG_DATABASE ?? 'filesharing_test';

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000';

export const TEST_PASSWORD = 'password123';

/** A clock the tests can move forward, so expiry is tested without sleeping. */
export const TEST_EPOCH = new Date('2026-01-01T12:00:00Z');

export class TestClock implements Clock {
  constructor(private current = new Date(TEST_EPOCH)) {}
  reset(): void {
    this.current = new Date(TEST_EPOCH);
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceHours(hours: number): void {
    this.current = new Date(this.current.getTime() + hours * 3_600_000);
  }
}

async function ensureTestDatabase(): Promise<string> {
  const admin = new Client({
    host: PG_HOST,
    port: Number(PG_PORT),
    user: PG_USER,
    password: PG_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  return `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${TEST_DB}`;
}

export interface Harness {
  app: FastifyInstance;
  storage: FileStorage;
  clock: TestClock;
  config: Config;
  /** Every email the app sent during the current test. */
  mailer: MemoryMailer;
  /** The application's own pool, for tests that need a transaction. */
  pool: Pool;
  /** Runs every ready background job now (emails, notification fan-out, purges). */
  runJobs(): Promise<number>;
  /**
   * Runs ready jobs and waits until none are queued or running, including jobs the background
   * worker has already claimed. Use before asserting on a job's side effects.
   */
  drainJobs(timeoutMs?: number): Promise<void>;
  truncate(): Promise<void>;
  close(): Promise<void>;
  /** Reads a raw value straight from the database, bypassing the API. */
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  objectExists(key: string): Promise<boolean>;
}

export async function createHarness(options?: {
  storage?: FileStorage;
  env?: Record<string, string>;
  /** Set false to run jobs only through runJobs(), for tests of the queue itself. */
  worker?: boolean;
}): Promise<Harness> {
  const databaseUrl = await ensureTestDatabase();
  const bucket = `test-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  const config = loadConfig({
    NODE_ENV: 'test',
    API_PORT: '4001',
    WEB_URL: 'http://localhost:3000',
    DATABASE_URL: databaseUrl,
    S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT: S3_ENDPOINT,
    S3_BUCKET: bucket,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    SEED_DEMO_DATA: 'false',
    ...options?.env,
  });

  const pool = createPool(databaseUrl);
  const logger = pino({ level: 'silent' });
  await runMigrations(pool, path.resolve(__dirname, '../../migrations'), logger);

  const realStorage = new S3Storage({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  });
  await realStorage.ensureBucket();

  const storage = options?.storage ?? realStorage;
  const clock = new TestClock();
  const mailer = new MemoryMailer();
  const app = await buildApp({ config, pool, storage, multipartStorage: realStorage, logger, clock, mailer });
  await app.ready();
  // A real worker runs alongside the tests, exactly as in production. Tests that need a job's
  // effect at a precise moment call runJobs() instead of waiting for it.
  const stopWorker =
    options?.worker === false ? async () => undefined : app.services.jobs.start(app.jobHandlers, { pollMs: 25 });

  return {
    app,
    storage,
    clock,
    config,
    mailer,
    pool,
    runJobs: () => app.services.jobs.runReady(app.jobHandlers, 1000),
    async drainJobs(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await app.services.jobs.runReady(app.jobHandlers, 1000);
        const { rows } = await pool.query<{ pending: string }>(
          `SELECT COUNT(*) AS pending FROM jobs WHERE status = 'running' OR (status = 'queued' AND run_at <= $1)`,
          [clock.now()],
        );
        if (Number(rows[0]!.pending) === 0) return;
        if (Date.now() > deadline) throw new Error('background jobs did not finish');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async truncate() {
      // Audit, notification and share-access writes are fire-and-forget by design, so the
      // previous test's writes can still be landing when the next test truncates. TRUNCATE
      // then deadlocks against those inserts. Retrying on deadlock (40P01) makes the reset
      // deterministic without making production writes blocking just to suit the tests.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await pool.query(
            `TRUNCATE notifications, audit_events, share_access_events, invitations, shares,
                      documents, folders, login_failures, password_resets, workspace_members,
                      workspaces, sessions, users, jobs, rate_limits CASCADE`,
          );
          // Each test starts at the same moment, so a test that moved time cannot leak it.
          clock.reset();
          mailer.clear();
          return;
        } catch (error) {
          if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        }
      }
    },
    async close() {
      await stopWorker();
      await app.close();
      await pool.end();
    },
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const { rows } = await pool.query(sql, params);
      return rows as T[];
    },
    async objectExists(key: string) {
      try {
        await realStorage.download(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Registers a user and returns the session cookie plus their first workspace. */
export async function registerUser(
  app: FastifyInstance,
  email: string,
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  const cookie = raw.split(';')[0]!;
  const userId = response.json().user.id as string;

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  const workspaceId = me.json().workspaces[0].id as string;

  return { cookie, userId, workspaceId };
}

const PDF = Buffer.from('%PDF-1.4\ntest document body\n%%EOF\n', 'utf8');

/** Uploads a small valid PDF and returns the created document. */
export async function uploadDocument(
  app: FastifyInstance,
  cookie: string,
  workspaceId: string,
  filename = 'report.pdf',
  body: Buffer = PDF,
  contentType = 'application/pdf',
) {
  const boundary = '----harness';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  return app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

export { PDF as SAMPLE_PDF };
