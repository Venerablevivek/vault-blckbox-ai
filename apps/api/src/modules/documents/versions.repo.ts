import type { Db } from '../../db/pool';
import type { DocumentRow } from './documents.repo';
import type { ScanStatus } from './scan-policy';

export interface VersionRow {
  id: string;
  document_id: string;
  workspace_id: string;
  version: number;
  filename: string;
  storage_key: string;
  mime_type: string;
  size: string;
  sha256: Buffer | null;
  scan_status: ScanStatus;
  uploaded_by: string;
  created_at: Date;
}

export const versionsRepo = {
  /** Locks a live document for the rest of the transaction, so two new versions can't race. */
  async lockLive(db: Db, documentId: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [documentId],
    );
    return rows[0] ?? null;
  },

  /** Moves the document's current content into its history, under its current number. */
  async archiveCurrent(db: Db, versionId: string, document: DocumentRow): Promise<void> {
    await db.query(
      `INSERT INTO document_versions
         (id, document_id, workspace_id, version, filename, storage_key, mime_type, size, sha256, scan_status,
          uploaded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        versionId,
        document.id,
        document.workspace_id,
        document.version,
        document.filename,
        document.storage_key,
        document.mime_type,
        document.size,
        document.sha256,
        document.scan_status,
        document.version_uploaded_by ?? document.uploaded_by,
        document.version_created_at ?? document.created_at,
      ],
    );
  },

  /** Makes new content the document's current version. */
  async setCurrent(
    db: Db,
    documentId: string,
    content: {
      storageKey: string;
      size: number;
      sha256: Buffer | null;
      scanStatus: ScanStatus;
      version: number;
      uploadedBy: string;
      at: Date;
    },
  ): Promise<DocumentRow> {
    const { rows } = await db.query<DocumentRow>(
      `UPDATE documents
          SET storage_key = $2, size = $3, sha256 = $4, scan_status = $5, scanned_at = NULL, scan_signature = NULL,
              version = $6, version_uploaded_by = $7, version_created_at = $8
        WHERE id = $1
        RETURNING *`,
      [
        documentId,
        content.storageKey,
        content.size,
        content.sha256,
        content.scanStatus,
        content.version,
        content.uploadedBy,
        content.at,
      ],
    );
    return rows[0]!;
  },

  /** Earlier versions, newest first, with who uploaded each. */
  async list(db: Db, documentId: string): Promise<Array<VersionRow & { uploaded_by_email: string }>> {
    const { rows } = await db.query<VersionRow & { uploaded_by_email: string }>(
      `SELECT v.*, u.email AS uploaded_by_email
         FROM document_versions v JOIN users u ON u.id = v.uploaded_by
        WHERE v.document_id = $1
        ORDER BY v.version DESC`,
      [documentId],
    );
    return rows;
  },

  async find(db: Db, documentId: string, version: number): Promise<VersionRow | null> {
    const { rows } = await db.query<VersionRow>(
      'SELECT * FROM document_versions WHERE document_id = $1 AND version = $2',
      [documentId, version],
    );
    return rows[0] ?? null;
  },

  /** Removes one earlier version's row, returning what it held so its object can go too. */
  async delete(db: Db, id: string): Promise<VersionRow | null> {
    const { rows } = await db.query<VersionRow>('DELETE FROM document_versions WHERE id = $1 RETURNING *', [id]);
    return rows[0] ?? null;
  },

  /** Versions beyond the newest `keep`, oldest first: the ones to prune. */
  async beyond(db: Db, documentId: string, keep: number): Promise<VersionRow[]> {
    const { rows } = await db.query<VersionRow>(
      `SELECT * FROM document_versions WHERE document_id = $1
        ORDER BY version DESC OFFSET $2`,
      [documentId, keep],
    );
    return rows.reverse();
  },

  /** Every earlier version's object key for a document, for purging it. */
  async storageKeys(db: Db, documentId: string): Promise<string[]> {
    const { rows } = await db.query<{ storage_key: string }>(
      'SELECT storage_key FROM document_versions WHERE document_id = $1',
      [documentId],
    );
    return rows.map((r) => r.storage_key);
  },
};
