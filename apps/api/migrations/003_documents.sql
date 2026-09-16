-- Documents. PostgreSQL holds metadata only; the bytes live in MinIO under storage_key.
--
-- workspace_id is NOT NULL on purpose: every document belongs to exactly one workspace,
-- so there is exactly one authorization question to answer for any document.
--
-- storage_key is UNIQUE so two rows can never point at the same object, which means
-- deleting one document can never remove another document's bytes.

CREATE TABLE documents (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by  uuid NOT NULL REFERENCES users(id)      ON DELETE RESTRICT,
  filename     text   NOT NULL,
  storage_key  text   NOT NULL UNIQUE,
  mime_type    text   NOT NULL,
  size         bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

-- Every listing query filters on (workspace_id, deleted_at IS NULL) and sorts by
-- created_at, so the index is partial and ordered to match.
CREATE INDEX documents_workspace_live_idx
  ON documents (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;
