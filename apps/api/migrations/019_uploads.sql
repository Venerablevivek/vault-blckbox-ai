-- Direct uploads: the browser sends file bytes straight to object storage in parts (S3 multipart
-- upload) and the API only coordinates. A row per upload session tracks what was promised (name,
-- size, type, destination) so completion can be verified against it, and so abandoned uploads can
-- be aborted and their reserved quota returned.

CREATE TABLE uploads (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id        uuid REFERENCES folders(id) ON DELETE SET NULL,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The document this upload becomes. Chosen up front because it names the object key.
  document_id      uuid NOT NULL UNIQUE,
  filename         text NOT NULL,
  declared_mime    text NOT NULL,
  size             bigint NOT NULL CHECK (size > 0),
  part_size        integer NOT NULL CHECK (part_size >= 5242880),
  part_count       integer NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  storage_key      text NOT NULL UNIQUE,
  storage_upload_id text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completing', 'completed', 'aborted', 'expired', 'rejected')),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  finished_at      timestamptz
);

CREATE INDEX uploads_open_idx ON uploads (expires_at) WHERE status IN ('pending', 'completing');
CREATE INDEX uploads_workspace_idx ON uploads (workspace_id, created_at DESC);
