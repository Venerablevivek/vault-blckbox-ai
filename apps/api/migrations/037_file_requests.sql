-- File requests: a link that lets someone outside the workspace upload files into a folder,
-- without an account. The mirror image of a share link. As with every link, only sha256(token)
-- is stored. A request always expires; it also dies when revoked, when its folder or workspace
-- is deleted, or when the person who made it can no longer upload there.

CREATE TABLE file_requests (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- NULL: the top level of the workspace.
  folder_id        uuid REFERENCES folders (id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash       bytea NOT NULL UNIQUE,
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  message          text CHECK (length(message) <= 1000),
  max_files        integer CHECK (max_files BETWEEN 1 AND 500),
  received_count   integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  last_received_at timestamptz
);

CREATE INDEX file_requests_workspace_idx ON file_requests (workspace_id, created_at DESC);
CREATE INDEX file_requests_creator_idx ON file_requests (workspace_id, created_by) WHERE revoked_at IS NULL;

-- Who sent each file. The document itself is owned by the person who made the request (someone
-- outside has no account); this row keeps the sender's own name and address.
CREATE TABLE file_request_uploads (
  id           uuid PRIMARY KEY,
  request_id   uuid NOT NULL REFERENCES file_requests (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  sender_name  text NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 80),
  sender_email text CHECK (length(sender_email) <= 255),
  filename     text NOT NULL,
  size         bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX file_request_uploads_request_idx ON file_request_uploads (request_id, created_at DESC);

ALTER TABLE file_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON file_requests USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
ALTER TABLE file_request_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON file_request_uploads USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
