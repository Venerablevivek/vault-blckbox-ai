import type { Db } from '../../db/pool';

export interface FileRequestRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  created_by: string;
  creator_email: string;
  folder_name: string | null;
  title: string;
  message: string | null;
  max_files: number | null;
  received_count: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_received_at: Date | null;
}

export interface ResolvedFileRequest extends FileRequestRow {
  workspace_name: string;
}

export interface ReceivedFileRow {
  id: string;
  document_id: string;
  sender_name: string;
  sender_email: string | null;
  filename: string;
  size: string;
  created_at: Date;
}

const COLUMNS = `r.id, r.workspace_id, r.folder_id, r.created_by, u.email AS creator_email, f.name AS folder_name,
                 r.title, r.message, r.max_files, r.received_count, r.created_at, r.expires_at, r.revoked_at,
                 r.last_received_at`;
const FROM = `FROM file_requests r
              JOIN users u ON u.id = r.created_by
              LEFT JOIN folders f ON f.id = r.folder_id`;

export const fileRequestsRepo = {
  async insert(
    db: Db,
    row: {
      id: string;
      workspaceId: string;
      folderId: string | null;
      createdBy: string;
      tokenHash: Buffer;
      title: string;
      message: string | null;
      maxFiles: number | null;
      createdAt: Date;
      expiresAt: Date;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO file_requests
         (id, workspace_id, folder_id, created_by, token_hash, title, message, max_files, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        row.workspaceId,
        row.folderId,
        row.createdBy,
        row.tokenHash,
        row.title,
        row.message,
        row.maxFiles,
        row.createdAt,
        row.expiresAt,
      ],
    );
  },

  async findById(db: Db, id: string): Promise<FileRequestRow | null> {
    const { rows } = await db.query<FileRequestRow>(`SELECT ${COLUMNS} ${FROM} WHERE r.id = $1`, [id]);
    return rows[0] ?? null;
  },

  /** A workspace's requests, newest first; revoked and expired ones included, so history stays visible. */
  async listForWorkspace(db: Db, workspaceId: string, limit: number): Promise<FileRequestRow[]> {
    const { rows } = await db.query<FileRequestRow>(
      `SELECT ${COLUMNS} ${FROM} WHERE r.workspace_id = $1 ORDER BY r.created_at DESC, r.id LIMIT $2`,
      [workspaceId, limit],
    );
    return rows;
  },

  /** A request that can still take files: not revoked, not expired, in a live workspace. */
  async resolveLive(db: Db, tokenHash: Buffer, now: Date): Promise<ResolvedFileRequest | null> {
    const { rows } = await db.query<ResolvedFileRequest>(
      `SELECT ${COLUMNS}, w.name AS workspace_name ${FROM}
         JOIN workspaces w ON w.id = r.workspace_id
        WHERE r.token_hash = $1
          AND r.revoked_at IS NULL
          AND r.expires_at > $2
          AND w.deleted_at IS NULL`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  /** Whether a token belonged to a request at all, usable or not: tells 410 from 404. */
  async exists(db: Db, tokenHash: Buffer): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM file_requests WHERE token_hash = $1', [tokenHash]);
    return (rowCount ?? 0) > 0;
  },

  /**
   * Takes one of the request's file slots, atomically: two uploads racing for the last slot
   * can't both win. Returns false when the request is full or no longer live.
   */
  async claimSlot(db: Db, id: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE file_requests
          SET received_count = received_count + 1, last_received_at = $2
        WHERE id = $1
          AND revoked_at IS NULL
          AND expires_at > $2
          AND (max_files IS NULL OR received_count < max_files)`,
      [id, now],
    );
    return (rowCount ?? 0) > 0;
  },

  async recordUpload(
    db: Db,
    row: {
      id: string;
      requestId: string;
      workspaceId: string;
      documentId: string;
      senderName: string;
      senderEmail: string | null;
      filename: string;
      size: number;
      at: Date;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO file_request_uploads
         (id, request_id, workspace_id, document_id, sender_name, sender_email, filename, size, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.requestId,
        row.workspaceId,
        row.documentId,
        row.senderName,
        row.senderEmail,
        row.filename,
        row.size,
        row.at,
      ],
    );
  },

  /** What a request has received, newest first. Files later deleted for good drop out. */
  async received(db: Db, requestId: string, limit: number): Promise<ReceivedFileRow[]> {
    const { rows } = await db.query<ReceivedFileRow>(
      `SELECT id, document_id, sender_name, sender_email, filename, size, created_at
         FROM file_request_uploads
        WHERE request_id = $1
        ORDER BY created_at DESC, id
        LIMIT $2`,
      [requestId, limit],
    );
    return rows;
  },

  async revoke(db: Db, id: string, now: Date): Promise<void> {
    await db.query('UPDATE file_requests SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, now]);
  },
};
