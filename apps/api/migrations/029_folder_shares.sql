-- Share links to a whole folder: the recipient can browse the folder and everything below it,
-- download single files or a zip. Like document links, only sha256(token) is stored, and a link
-- dies when it is revoked, expires, its folder is deleted, or its workspace is.

CREATE TABLE folder_shares (
  id               uuid PRIMARY KEY,
  folder_id        uuid NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL UNIQUE,
  created_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  revoked_at       timestamptz,
  password_hash    text,
  -- Counters, so the sender can see the link being used without a separate event table.
  opens            integer NOT NULL DEFAULT 0,
  downloads        integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  -- Wrong passwords in the current window, for the per-link lockout.
  failed_unlocks       integer NOT NULL DEFAULT 0,
  failed_unlock_window timestamptz
);

CREATE INDEX folder_shares_folder_idx ON folder_shares (folder_id) WHERE revoked_at IS NULL;
CREATE INDEX folder_shares_creator_idx ON folder_shares (workspace_id, created_by) WHERE revoked_at IS NULL;

ALTER TABLE folder_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON folder_shares USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
