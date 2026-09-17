import type { Db } from '../../db/pool';

export type UploadStatus = 'pending' | 'completing' | 'completed' | 'aborted' | 'expired' | 'rejected';

export interface UploadRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  created_by: string;
  document_id: string;
  filename: string;
  declared_mime: string;
  size: string;
  part_size: number;
  part_count: number;
  storage_key: string;
  storage_upload_id: string;
  status: UploadStatus;
  created_at: Date;
  expires_at: Date;
}

export const uploadsRepo = {
  async insert(
    db: Db,
    upload: {
      id: string;
      workspaceId: string;
      folderId: string | null;
      createdBy: string;
      documentId: string;
      filename: string;
      declaredMime: string;
      size: number;
      partSize: number;
      partCount: number;
      storageKey: string;
      storageUploadId: string;
      now: Date;
      expiresAt: Date;
    },
  ): Promise<UploadRow> {
    const { rows } = await db.query<UploadRow>(
      `INSERT INTO uploads (id, workspace_id, folder_id, created_by, document_id, filename, declared_mime, size,
                            part_size, part_count, storage_key, storage_upload_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        upload.id,
        upload.workspaceId,
        upload.folderId,
        upload.createdBy,
        upload.documentId,
        upload.filename,
        upload.declaredMime,
        upload.size,
        upload.partSize,
        upload.partCount,
        upload.storageKey,
        upload.storageUploadId,
        upload.now,
        upload.expiresAt,
      ],
    );
    return rows[0]!;
  },

  async findById(db: Db, id: string): Promise<UploadRow | null> {
    const { rows } = await db.query<UploadRow>('SELECT * FROM uploads WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /** Atomically moves an upload from one status to another. Returns the row only if it moved. */
  async transition(db: Db, id: string, from: UploadStatus[], to: UploadStatus, now: Date): Promise<UploadRow | null> {
    const finished = ['completed', 'aborted', 'expired', 'rejected'].includes(to);
    const { rows } = await db.query<UploadRow>(
      `UPDATE uploads SET status = $3, finished_at = CASE WHEN $4 THEN $5::timestamptz ELSE NULL END
        WHERE id = $1 AND status = ANY($2) RETURNING *`,
      [id, from, to, finished, now],
    );
    return rows[0] ?? null;
  },

  async expired(db: Db, now: Date, limit: number): Promise<UploadRow[]> {
    const { rows } = await db.query<UploadRow>(
      `SELECT * FROM uploads WHERE status IN ('pending', 'completing') AND expires_at < $1 ORDER BY expires_at LIMIT $2`,
      [now, limit],
    );
    return rows;
  },
};
