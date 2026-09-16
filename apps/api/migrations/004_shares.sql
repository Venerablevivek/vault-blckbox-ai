-- Public share links.
--
-- A share link is a database row, not a long-lived presigned S3 URL. That is what
-- makes it revocable, expirable, and able to die the moment its document is deleted.
-- Only sha256(token) is stored; the plaintext token is shown to the creator once.

CREATE TABLE shares (
  id          uuid PRIMARY KEY,
  document_id uuid  NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,     -- doubles as the lookup index
  expires_at  timestamptz,               -- NULL means "never expires"
  created_by  uuid  NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE INDEX shares_document_id_idx ON shares (document_id);
