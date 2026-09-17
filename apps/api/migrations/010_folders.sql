-- Folders.
--
-- A plain adjacency list (parent_id). Folders are workspace-scoped like everything else,
-- so the same membership check that protects documents protects folders.
--
-- Deleting a folder is only allowed when it is empty (enforced in the service), so a
-- folder delete can never silently take documents with it. documents.folder_id is
-- ON DELETE SET NULL only as a backstop for trashed documents still pointing at a folder
-- that was later removed: when restored they land at the workspace root.

CREATE TABLE folders (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES folders(id) ON DELETE RESTRICT,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Sibling names are unique, case-insensitively. Root folders have a NULL parent, which a
-- plain unique index would treat as distinct, so NULL is folded to a fixed sentinel.
CREATE UNIQUE INDEX folders_sibling_name_idx
  ON folders (workspace_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE INDEX folders_parent_idx ON folders (workspace_id, parent_id);

ALTER TABLE documents
  ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX documents_folder_live_idx
  ON documents (workspace_id, folder_id, created_at DESC) WHERE deleted_at IS NULL;
