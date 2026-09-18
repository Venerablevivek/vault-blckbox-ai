import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../db/pool';
import type { Clock } from '../types';
import { jobsRepo, type JobRow } from './jobs.repo';

/** Payload type for each queue. Adding a queue means adding it here and a handler in the worker. */
export interface JobPayloads {
  'email.send': { to: string; subject: string; text: string; html: string };
  'notifications.fanout': {
    workspaceId: string;
    exceptUserId: string;
    type: string;
    title: string;
    body: string | null;
    resourceId: string | null;
  };
  'document.checksum': { documentId: string };
  'document.scan': { documentId: string };
  'document.process': { documentId: string };
  'workspace.purge': { workspaceId: string };
  'maintenance.run': Record<string, never>;
}
export type QueueName = keyof JobPayloads;

export type JobHandlers = { [Q in QueueName]: (payload: JobPayloads[Q], job: JobRow) => Promise<void> };

export interface EnqueueOptions {
  runAt?: Date;
  /** Jobs sharing a dedupe key in a queue collapse into one while unfinished. */
  dedupeKey?: string;
  /**
   * With a dedupe key: enqueue only if no job with that key exists at all, finished or not. For
   * scheduled work keyed by its time slot, so a slot that already ran isn't run again.
   */
  once?: boolean;
  maxAttempts?: number;
}

/** How long a claimed job is reserved before another worker may assume its worker died. */
export const JOB_LOCK_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const NOTIFY_CHANNEL = 'jobs';

/** Delay before retry `attempt` (1-based): 5s, 10s, 20s … capped at an hour, with ±20% jitter. */
export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export function createJobQueue(deps: { pool: Pool; listenPool?: Pool; clock: Clock; logger: Logger }) {
  const { pool, clock, logger } = deps;
  // LISTEN needs a session of its own, which a transaction-pooling proxy can't give.
  const listenPool = deps.listenPool ?? pool;

  const queue = {
    /**
     * Enqueues a job using `db`, which may be a transaction: the job then exists exactly when
     * the transaction commits. Returns false when a job with the same dedupe key is unfinished.
     */
    async enqueue<Q extends QueueName>(
      db: Db,
      queue: Q,
      payload: JobPayloads[Q],
      options: EnqueueOptions = {},
    ): Promise<boolean> {
      const now = clock.now();
      const inserted = await jobsRepo.insert(db, {
        id: randomUUID(),
        queue,
        payload,
        runAt: options.runAt ?? now,
        dedupeKey: options.dedupeKey ?? null,
        maxAttempts: options.maxAttempts ?? 5,
        once: options.once === true && options.dedupeKey !== undefined,
        now,
      });
      // Delivered on commit, so a worker waiting on LISTEN wakes as soon as the job is visible.
      if (inserted) await db.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, queue]);
      return inserted;
    },

    /**
     * Claims and runs ready jobs until none are left or `limit` is reached. Returns how many ran.
     * Used by the worker loop, and directly by tests.
     */
    async runReady(handlers: Partial<JobHandlers>, limit = 50): Promise<number> {
      const queues = Object.keys(handlers) as QueueName[];
      let processed = 0;
      while (processed < limit) {
        const [job] = await jobsRepo.claim(pool, queues, clock.now(), JOB_LOCK_MS, 1);
        if (!job) break;
        processed += 1;
        const handler = handlers[job.queue as QueueName] as
          ((payload: unknown, job: JobRow) => Promise<void>) | undefined;
        try {
          if (!handler) throw new Error(`no handler for queue ${job.queue}`);
          await handler(job.payload, job);
          await jobsRepo.complete(pool, job.id, clock.now());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (job.attempts >= job.max_attempts) {
            await jobsRepo.fail(pool, job.id, message, clock.now());
            logger.error(
              { err: error, jobId: job.id, queue: job.queue, attempts: job.attempts },
              'job failed permanently',
            );
          } else {
            const retryAt = new Date(clock.now().getTime() + retryDelayMs(job.attempts));
            await jobsRepo.retry(pool, job.id, message, retryAt);
            logger.warn(
              { err: error, jobId: job.id, queue: job.queue, attempts: job.attempts, retryAt },
              'job failed; will retry',
            );
          }
        }
      }
      return processed;
    },

    /**
     * Runs a worker loop: waits on LISTEN for new jobs, and polls every `pollMs` as a backstop
     * (for scheduled jobs, retries, and jobs whose worker died). Returns a stop function that
     * resolves once the job in progress, if any, has finished.
     */
    start(handlers: Partial<JobHandlers>, options: { pollMs?: number } = {}): () => Promise<void> {
      const pollMs = options.pollMs ?? 1_000;
      let stopped = false;
      let wake: (() => void) | null = null;
      let listener: PoolClient | null = null;
      let current: Promise<unknown> = Promise.resolve();

      const sleep = () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });

      void (async () => {
        try {
          listener = await listenPool.connect();
          listener.on('notification', () => wake?.());
          await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
        } catch (error) {
          logger.warn({ err: error }, 'job LISTEN unavailable; polling only');
        }
        while (!stopped) {
          current = queue.runReady(handlers).catch((error: unknown) => logger.error({ err: error }, 'job loop error'));
          await current;
          if (!stopped) await sleep();
        }
      })();

      return async () => {
        stopped = true;
        wake?.();
        await current;
        if (listener) {
          await listener.query(`UNLISTEN ${NOTIFY_CHANNEL}`).catch(() => undefined);
          listener.release();
        }
      };
    },

    stats: (db: Db = pool) => jobsRepo.stats(db),
  };
  return queue;
}

export type JobQueue = ReturnType<typeof createJobQueue>;
