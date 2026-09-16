-- Workspace invitations.
--
-- An invitation is bound to an email address: the accepting account's email must match,
-- otherwise forwarding the link would be a privilege escalation.
-- Single use is expressed by accepted_at being non-null.

CREATE TABLE invitations (
  id           uuid PRIMARY KEY,
  workspace_id uuid  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text  NOT NULL,           -- always lowercased by the application
  token_hash   bytea NOT NULL UNIQUE,
  role         workspace_role NOT NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_by   uuid  NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Re-inviting the same address replaces the pending invite instead of duplicating it.
CREATE UNIQUE INDEX invitations_pending_idx
  ON invitations (workspace_id, email)
  WHERE accepted_at IS NULL;

CREATE INDEX invitations_email_idx ON invitations (email);
