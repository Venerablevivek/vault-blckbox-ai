-- File integrity, storage quotas and workspace deletion.

-- SHA-256 of the stored bytes, computed by the API. Proves a file is intact and lets an
-- upload say "this is identical to a file you already have". NULL only for rows created
-- before this migration; the maintenance job backfills them.
ALTER TABLE documents
  ADD COLUMN sha256 bytea CHECK (sha256 IS NULL OR length(sha256) = 32);

CREATE INDEX documents_sha256_idx
  ON documents (workspace_id, sha256) WHERE deleted_at IS NULL AND sha256 IS NOT NULL;

-- Quota accounting. storage_used_bytes counts every stored object, including trashed ones
-- (their bytes still exist until purged). It is changed only by a conditional UPDATE in
-- the same transaction as the document row, so concurrent uploads cannot overshoot.
ALTER TABLE workspaces
  ADD COLUMN storage_quota_bytes bigint NOT NULL DEFAULT 5368709120 CHECK (storage_quota_bytes > 0),
  ADD COLUMN storage_used_bytes  bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE workspaces w
   SET storage_used_bytes = COALESCE((SELECT SUM(d.size) FROM documents d WHERE d.workspace_id = w.id), 0);

-- Deleted workspaces waiting for the maintenance job to remove their objects and rows.
CREATE INDEX workspaces_deleted_idx ON workspaces (deleted_at) WHERE deleted_at IS NOT NULL;
