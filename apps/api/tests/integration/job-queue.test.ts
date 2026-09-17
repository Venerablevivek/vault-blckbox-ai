import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx';
import { JOB_LOCK_MS, retryDelayMs, type JobHandlers } from '../../src/jobs/queue';
import { createHarness, type Harness } from '../helpers/harness';

/** The Postgres job queue: transactional enqueue, exactly-once claiming, retries and recovery. */
describe('job queue', () => {
  let h: Harness;
  const jobs = () => h.app.services.jobs;
  const pool = () => h.pool;

  beforeAll(async () => {
    h = await createHarness({ worker: false });
  });
  afterAll(async () => h.close());
  beforeEach(async () => h.truncate());

  const email = (to: string) => ({ to, subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' });
  const rows = () =>
    h.query<{ status: string; attempts: number; last_error: string | null }>(
      'SELECT status, attempts, last_error FROM jobs',
    );

  it('creates no job when the enqueuing transaction rolls back', async () => {
    await expect(
      withTransaction(pool(), async (tx) => {
        await jobs().enqueue(tx, 'email.send', email('a@example.com'));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await rows()).toHaveLength(0);
  });

  it('collapses jobs with the same dedupe key while one is unfinished', async () => {
    expect(await jobs().enqueue(pool(), 'maintenance.run', {}, { dedupeKey: 'hour-1' })).toBe(true);
    expect(await jobs().enqueue(pool(), 'maintenance.run', {}, { dedupeKey: 'hour-1' })).toBe(false);
    expect(await rows()).toHaveLength(1);

    let runs = 0;
    await jobs().runReady({ 'maintenance.run': async () => void (runs += 1) });
    expect(runs).toBe(1);
    // Once finished, the key is free again.
    expect(await jobs().enqueue(pool(), 'maintenance.run', {}, { dedupeKey: 'hour-1' })).toBe(true);
  });

  it('with once, never re-runs a key that already finished', async () => {
    let runs = 0;
    const handlers: Partial<JobHandlers> = { 'maintenance.run': async () => void (runs += 1) };
    // A worker tries to schedule the same hourly slot every minute.
    for (let minute = 0; minute < 5; minute++) {
      await jobs().enqueue(pool(), 'maintenance.run', {}, { dedupeKey: 'every-60m:100', once: true });
      await jobs().runReady(handlers);
    }
    expect(runs).toBe(1);
    await jobs().enqueue(pool(), 'maintenance.run', {}, { dedupeKey: 'every-60m:101', once: true });
    await jobs().runReady(handlers);
    expect(runs).toBe(2);
  });

  it('never gives the same job to two workers', async () => {
    for (let i = 0; i < 30; i++) await jobs().enqueue(pool(), 'email.send', email(`user${i}@example.com`));
    const seen: string[] = [];
    const handlers: Partial<JobHandlers> = {
      'email.send': async (message) => {
        seen.push(message.to);
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    };
    await Promise.all([1, 2, 3, 4].map(() => jobs().runReady(handlers, 100)));
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect((await rows()).every((r) => r.status === 'done')).toBe(true);
  });

  it('does not run a job before its run_at', async () => {
    await jobs().enqueue(pool(), 'email.send', email('later@example.com'), {
      runAt: new Date(h.clock.now().getTime() + 60_000),
    });
    let runs = 0;
    const handlers: Partial<JobHandlers> = { 'email.send': async () => void (runs += 1) };
    await jobs().runReady(handlers);
    expect(runs).toBe(0);
    h.clock.advanceHours(1 / 60 + 0.001);
    await jobs().runReady(handlers);
    expect(runs).toBe(1);
  });

  it('retries a failing job with backoff, then dead-letters it after max attempts', async () => {
    await jobs().enqueue(pool(), 'email.send', email('flaky@example.com'), { maxAttempts: 3 });
    let calls = 0;
    const handlers: Partial<JobHandlers> = {
      'email.send': async () => {
        calls += 1;
        throw new Error(`smtp down ${calls}`);
      },
    };

    await jobs().runReady(handlers);
    expect(await rows()).toEqual([{ status: 'queued', attempts: 1, last_error: 'smtp down 1' }]);
    // Not retried until the backoff has passed.
    await jobs().runReady(handlers);
    expect(calls).toBe(1);

    h.clock.advanceHours(1);
    await jobs().runReady(handlers);
    h.clock.advanceHours(1);
    await jobs().runReady(handlers);
    expect(calls).toBe(3);
    expect(await rows()).toEqual([{ status: 'failed', attempts: 3, last_error: 'smtp down 3' }]);

    h.clock.advanceHours(24);
    await jobs().runReady(handlers);
    expect(calls).toBe(3);
  });

  it('picks up a job whose worker died, once its lock expires', async () => {
    await jobs().enqueue(pool(), 'email.send', email('orphan@example.com'));
    // A worker claims the job and dies without finishing it.
    await h.query(`UPDATE jobs SET status = 'running', attempts = 1, locked_until = $1`, [
      new Date(h.clock.now().getTime() + JOB_LOCK_MS),
    ]);

    let runs = 0;
    const handlers: Partial<JobHandlers> = { 'email.send': async () => void (runs += 1) };
    await jobs().runReady(handlers);
    expect(runs).toBe(0);

    h.clock.advanceHours(JOB_LOCK_MS / 3_600_000 + 0.01);
    await jobs().runReady(handlers);
    expect(runs).toBe(1);
    expect(await rows()).toEqual([{ status: 'done', attempts: 2, last_error: null }]);
  });

  it('wakes a waiting worker through LISTEN/NOTIFY rather than waiting for the next poll', async () => {
    const delivered: string[] = [];
    const stop = jobs().start({ 'email.send': async (message) => void delivered.push(message.to) }, { pollMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await jobs().enqueue(pool(), 'email.send', email('fast@example.com'));
    for (let i = 0; i < 40 && delivered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    await stop();
    expect(delivered).toEqual(['fast@example.com']);
  });

  it('removes finished jobs after their retention in the maintenance pass', async () => {
    await jobs().enqueue(pool(), 'email.send', email('old@example.com'));
    await jobs().runReady({ 'email.send': async () => undefined });
    h.clock.advanceHours(24 * 8);
    const result = await h.app.maintenance.runOnce();
    expect(result!.finishedJobs).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it('backs off exponentially with jitter, capped at an hour', () => {
    expect(retryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(retryDelayMs(4, () => 0.5)).toBe(40_000);
    expect(retryDelayMs(30, () => 0.5)).toBe(3_600_000);
    expect(retryDelayMs(1, () => 0)).toBe(4_000);
    expect(retryDelayMs(1, () => 1)).toBe(6_000);
  });
});
