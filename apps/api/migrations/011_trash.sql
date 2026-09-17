-- Trash and restore.
--
-- Deleting a document used to soft-delete the row and remove the object immediately, so a
-- mistaken delete could not be undone. Now a delete moves the document to the trash: the
-- row keeps deleted_at, the object stays in storage, and a cleanup job purges both after
-- 30 days. deleted_by records who trashed it, for the trash view and the audit trail.

ALTER TABLE documents
  ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX documents_trash_idx
  ON documents (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
