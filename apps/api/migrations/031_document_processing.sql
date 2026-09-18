-- Things derived from a document's current version by the worker: a thumbnail, a PDF preview of
-- an Office file (when office previews are on), and its text for search. All of it belongs to
-- one stored object (processed_key); a new version starts over.

ALTER TABLE documents
  ADD COLUMN thumbnail_key     text,
  ADD COLUMN preview_key       text,
  ADD COLUMN processed_key     text,
  ADD COLUMN processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'done', 'skipped', 'failed')),
  ADD COLUMN processed_at      timestamptz;

CREATE INDEX documents_processing_pending_idx ON documents (created_at) WHERE processing_status = 'pending';

-- The searchable text, kept out of the documents row so listings never carry it.
CREATE TABLE document_contents (
  document_id  uuid PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  body         text NOT NULL,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);

CREATE INDEX document_contents_tsv_idx ON document_contents USING gin (tsv);

ALTER TABLE document_contents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_contents USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
