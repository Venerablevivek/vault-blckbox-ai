-- A durable job queue in PostgreSQL: the transactional outbox and the work queue in one.
--
-- A job is inserted in the same transaction as the change that needs it (a password reset and
-- its email, a workspace deletion and its purge), so work is never lost after a commit and never
-- runs for a change that rolled back. Workers claim jobs with FOR UPDATE SKIP LOCKED, so any
-- number of them can run without taking the same job. A worker that dies mid-job leaves the job
-- 'running' with an expired lock; the next claim picks it up again.

CREATE TABLE jobs (
  id           uuid PRIMARY KEY,
  queue        text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_at       timestamptz NOT NULL,
  locked_until timestamptz,
  last_error   text,
  -- At most one unfinished job per (queue, dedupe_key): scheduled work enqueued by several
  -- workers, or the same email requested twice, collapses into one job.
  dedupe_key   text,
  created_at   timestamptz NOT NULL,
  finished_at  timestamptz
);

CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_stale_idx ON jobs (locked_until) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX jobs_finished_idx ON jobs (finished_at) WHERE status IN ('done', 'failed');
