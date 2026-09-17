-- Account security: password reset and visible, revocable sessions.
--
-- Reset tokens follow the same rule as every other bearer token in the system: 256 bits,
-- shown once (in the email), stored only as sha256. A token is single-use (used_at) and
-- short-lived (expires_at); resetting a password marks every other outstanding token used
-- and deletes every session, so a stolen session or an older reset email stops working.

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

ALTER TABLE users
  ADD COLUMN password_changed_at timestamptz;

-- What a person needs to recognise their own sessions: the browser, and when it was last used.
-- No IP address is stored; "Chrome on macOS, active 2 minutes ago" is enough to spot a stranger.
ALTER TABLE sessions
  ADD COLUMN user_agent   text,
  ADD COLUMN last_seen_at timestamptz;

UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;
