import type { Db } from '../db/pool';

export interface JobRow {
  id: string;
  queue: string;
  payload: unknown;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
}

export const jobsRepo = {
  /** Returns false when an unfinished job with the same (queue, dedupe_key) already exists. */
  async insert(
    db: Db,
    job: {
      id: string;
      queue: string;
      payload: unknown;
      runAt: Date;
      dedupeKey: string | null;
      maxAttempts: number;
      /** Skip if any job with this dedupe key exists, including finished ones. */
      once: boolean;
      now: Date;
    },
  ): Promise<boolean> {
    // The partial unique index makes concurrent inserts of an unfinished key safe; `once`
    // additionally skips keys that already finished (kept for the finished-job retention period).
    const { rowCount } = await db.query(
      `INSERT INTO jobs (id, queue, payload, run_at, dedupe_key, max_attempts, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7
        WHERE NOT ($8 AND EXISTS (SELECT 1 FROM jobs WHERE queue = $2 AND dedupe_key = $5))
       ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING`,
      [job.id, job.queue, JSON.stringify(job.payload), job.runAt, job.dedupeKey, job.maxAttempts, job.now, job.once],
    );
    return (rowCount ?? 0) > 0;
  },

  /**
   * Claims up to `limit` ready jobs: queued and due, or running with an expired lock (their worker
   * died). SKIP LOCKED lets concurrent workers claim different jobs without waiting on each other.
   */
  async claim(db: Db, queues: string[], now: Date, lockMs: number, limit: number): Promise<JobRow[]> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = $2::timestamptz + ($3 || ' milliseconds')::interval
        WHERE id IN (
          SELECT id FROM jobs
           WHERE queue = ANY($1)
             AND ((status = 'queued' AND run_at <= $2) OR (status = 'running' AND locked_until < $2))
           ORDER BY run_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED)
        RETURNING id, queue, payload, status, attempts, max_attempts, run_at, last_error`,
      [queues, now, String(lockMs), limit],
    );
    return rows;
  },

  async complete(db: Db, id: string, now: Date): Promise<void> {
    await db.query(`UPDATE jobs SET status = 'done', finished_at = $2, locked_until = NULL WHERE id = $1`, [id, now]);
  },

  async retry(db: Db, id: string, error: string, runAt: Date): Promise<void> {
    await db.query(
      `UPDATE jobs SET status = 'queued', run_at = $3, last_error = $2, locked_until = NULL WHERE id = $1`,
      [id, error.slice(0, 2000), runAt],
    );
  },

  /** Dead letter: kept with its error for inspection, never retried automatically. */
  async fail(db: Db, id: string, error: string, now: Date): Promise<void> {
    await db.query(
      `UPDATE jobs SET status = 'failed', last_error = $2, finished_at = $3, locked_until = NULL WHERE id = $1`,
      [id, error.slice(0, 2000), now],
    );
  },

  async deleteFinished(db: Db, doneBefore: Date, failedBefore: Date): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM jobs WHERE (status = 'done' AND finished_at < $1) OR (status = 'failed' AND finished_at < $2)`,
      [doneBefore, failedBefore],
    );
    return rowCount ?? 0;
  },

  async stats(db: Db): Promise<Array<{ queue: string; status: string; count: number }>> {
    const { rows } = await db.query<{ queue: string; status: string; count: string }>(
      'SELECT queue, status, COUNT(*) AS count FROM jobs GROUP BY queue, status ORDER BY queue, status',
    );
    return rows.map((r) => ({ queue: r.queue, status: r.status, count: Number(r.count) }));
  },
};
