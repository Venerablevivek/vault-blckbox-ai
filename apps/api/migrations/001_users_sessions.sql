-- Users and server-side sessions.
--
-- Sessions are stored server-side (rather than using a stateless JWT) so that access
-- can be revoked immediately: deleting the row ends the session on the very next
-- request. Only a SHA-256 hash of the session token is stored, so a leaked database
-- dump does not hand out live sessions.

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,   -- always lowercased by the application
  password_hash text NOT NULL,          -- argon2id
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,     -- sha256(token); the plaintext is never stored
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
