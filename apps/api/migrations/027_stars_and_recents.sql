-- Starred documents and recently opened documents, per person.

CREATE TABLE document_stars (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);
CREATE INDEX document_stars_document_idx ON document_stars (document_id);

-- One row per person per document: when they last opened (previewed, downloaded or uploaded) it.
CREATE TABLE document_recents (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  last_opened_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, document_id)
);
CREATE INDEX document_recents_user_idx ON document_recents (user_id, last_opened_at DESC);

-- Personal data: in a tenant context a person only sees their own rows.
ALTER TABLE document_stars ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON document_stars USING (app_user_visible(user_id)) WITH CHECK (true);
ALTER TABLE document_recents ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON document_recents USING (app_user_visible(user_id)) WITH CHECK (true);
