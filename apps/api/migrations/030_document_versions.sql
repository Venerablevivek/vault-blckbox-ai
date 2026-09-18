-- Document versions. The documents row always describes the current version; earlier versions
-- are rows here. Every version owns its own object in storage, and every version's bytes count
-- towards the workspace quota.

ALTER TABLE documents
  ADD COLUMN version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Who uploaded the current version, and when. Null means the original upload
  -- (uploaded_by / created_at). uploaded_by stays the document's owner for permissions.
  ADD COLUMN version_uploaded_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN version_created_at  timestamptz;

CREATE TABLE document_versions (
  id           uuid PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version >= 1),
  filename     text NOT NULL,
  storage_key  text NOT NULL UNIQUE,
  mime_type    text NOT NULL,
  size         bigint NOT NULL CHECK (size >= 0),
  sha256       bytea,
  scan_status  text NOT NULL CHECK (scan_status IN ('pending', 'clean', 'infected', 'unscanned')),
  uploaded_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL,
  UNIQUE (document_id, version)
);

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_versions USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
