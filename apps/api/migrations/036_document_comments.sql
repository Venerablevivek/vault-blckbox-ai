-- Comments on documents: a short discussion thread per file, visible to every member of its
-- workspace. A comment's workspace is copied onto it so row-level security can check it directly.

CREATE TABLE document_comments (
  id           uuid PRIMARY KEY,
  -- Insertion order, so a thread reads in the order it was written even when timestamps tie.
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  document_id  uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz
);

CREATE INDEX document_comments_document_idx ON document_comments (document_id, seq);

ALTER TABLE document_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_comments USING (app_workspace_visible(workspace_id)) WITH CHECK (true);
