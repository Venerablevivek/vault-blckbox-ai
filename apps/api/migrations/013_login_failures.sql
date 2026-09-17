-- Per-account login throttling.
--
-- Rate limits are per client IP, which does not slow down guessing one account's password
-- from many addresses. Failed attempts are recorded against a hash of the submitted email —
-- whether or not an account exists — so a locked response cannot be used to discover which
-- addresses are registered. A successful login clears the record.

CREATE TABLE login_failures (
  email_hash bytea NOT NULL,
  failed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_failures_lookup_idx ON login_failures (email_hash, failed_at DESC);
