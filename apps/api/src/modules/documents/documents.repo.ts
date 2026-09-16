import type { Db } from '../../db/pool';

export interface DocumentRow {
  id: string;
  workspace_id: string;
  uploaded_by: string;
  filename: string;
  storage_key: string;
  mime_type: string;
  size: string; // bigint arrives as a string from pg
  created_at: Date;
  deleted_at: Date | null;
}

export interface DocumentListRow extends DocumentRow {
  uploaded_by_email: string;
  /** Live (un-revoked) share links for this document. */
  link_count: string;
  /** Times those links have been opened or downloaded. */
  opens: string;
  last_accessed_at: Date | null;
}

/**
 * Every read here filters `deleted_at IS NULL` and, where the workspace is known,
 * carries workspace_id in the WHERE clause.
 *
 * With raw SQL there is no ORM to apply either filter automatically, so both are a
 * deliberate, reviewed part of each query — and `tests/security` asserts that a
 * soft-deleted document disappears from listing, download AND share resolution.
 */
export const documentsRepo = {
  async insert(
    db: Db,
    doc: {
      id: string;
      workspaceId: string;
      uploadedBy: string;
      filename: string;
      storageKey: string;
      mimeType: string;
      size: number;
    },
  ): Promise<DocumentRow> {
    const { rows } = await db.query<DocumentRow>(
      `INSERT INTO documents (id, workspace_id, uploaded_by, filename, storage_key, mime_type, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [doc.id, doc.workspaceId, doc.uploadedBy, doc.filename, doc.storageKey, doc.mimeType, doc.size],
    );
    return rows[0]!;
  },

  /**
   * Documents in a workspace, each with a rollup of its live share links and how often
   * they have been opened.
   *
   * The lateral join keeps this one query rather than one per row, and means the list can
   * show "shared · 7 opens" without the user having to open a dialog to find out.
   */
  async listByWorkspace(db: Db, workspaceId: string): Promise<DocumentListRow[]> {
    const { rows } = await db.query<DocumentListRow>(
      `SELECT d.*,
              u.email AS uploaded_by_email,
              COALESCE(l.link_count, 0)  AS link_count,
              COALESCE(l.opens, 0)       AS opens,
              l.last_accessed_at
         FROM documents d
         JOIN users u ON u.id = d.uploaded_by
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT sh.id) AS link_count,
                  COUNT(e.id)      FILTER (WHERE e.outcome IN ('resolved','downloaded')) AS opens,
                  MAX(e.accessed_at) FILTER (WHERE e.outcome IN ('resolved','downloaded')) AS last_accessed_at
             FROM shares sh
             LEFT JOIN share_access_events e ON e.share_id = sh.id
            WHERE sh.document_id = d.id AND sh.revoked_at IS NULL
         ) l ON true
        WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC`,
      [workspaceId],
    );
    return rows;
  },

  /**
   * Looks a document up by id alone.
   *
   * DELETE /api/documents/:id and GET /api/documents/:id/download are addressed without a
   * workspace in the path, so the caller's membership is checked against the workspace_id
   * on the row that comes back. The service does that check; this function never returns
   * a row to a caller that has not been authorized.
   */
  async findLiveById(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  /** Scoped variant used wherever the workspace is already known from the route. */
  async findLiveInWorkspace(
    db: Db,
    workspaceId: string,
    id: string,
  ): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [id, workspaceId],
    );
    return rows[0] ?? null;
  },

  async rename(db: Db, id: string, filename: string): Promise<void> {
    await db.query(
      'UPDATE documents SET filename = $2 WHERE id = $1 AND deleted_at IS NULL',
      [id, filename],
    );
  },

  /**
   * Soft delete. Returns the row only if this call is the one that deleted it, so a
   * double-delete cannot trigger the object removal twice.
   */
  async softDelete(db: Db, id: string, now: Date): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `UPDATE documents SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, now],
    );
    return rows[0] ?? null;
  },
};
