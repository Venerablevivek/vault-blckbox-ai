-- Email verification.
--
-- An account must prove it owns its address before it can reach anyone outside the platform
-- (create share links, invite people). Accounts that existed before this migration are treated as
-- verified. Tokens follow the same rules as reset links: 256-bit, stored as sha256, single-use.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at = created_at;

CREATE TABLE email_verifications (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX email_verifications_user_idx ON email_verifications (user_id, created_at DESC);
