-- Server-side search and keyset pagination.
--
-- Filename search is a substring match (ILIKE '%term%'), which a normal B-tree index cannot
-- serve. A trigram GIN index can, so search stays fast as a workspace grows. The extension
-- ships with PostgreSQL's contrib modules and is created by the database owner.
--
-- Keyset pagination sorts on (value, id), so ties never repeat or skip rows between pages.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX documents_filename_trgm_idx
  ON documents USING gin (filename gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE INDEX documents_name_sort_idx
  ON documents (workspace_id, lower(filename), id) WHERE deleted_at IS NULL;

CREATE INDEX documents_size_sort_idx
  ON documents (workspace_id, size, id) WHERE deleted_at IS NULL;
