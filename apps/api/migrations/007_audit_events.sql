-- Workspace audit trail.
--
-- Append-only record of who did what, in which workspace. Deliberately NOT tied to the
-- documents table by a foreign key: an audit entry must outlive the thing it describes,
-- otherwise deleting a document quietly erases the evidence that it ever existed.
-- resource_id is therefore a plain uuid, and the human-readable subject is denormalised
-- into metadata at write time.
--
-- Anonymous share-link access is recorded with a null actor.

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    uuid,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The activity feed reads one workspace, newest first.
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_events_actor_idx     ON audit_events (actor_user_id);
