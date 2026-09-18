import type { Db } from '../../db/pool';
import type { ScanStatus } from '../documents/scan-policy';

export interface FolderShareRow {
  id: string;
  folder_id: string;
  workspace_id: string;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  password_hash: string | null;
  opens: number;
  downloads: number;
  last_accessed_at: Date | null;
}

/** A usable link, with its folder's current name. */
export interface ResolvedFolderShare extends FolderShareRow {
  folder_name: string;
}

export interface SharedDocumentRow {
  id: string;
  filename: string;
  mime_type: string;
  size: string;
  created_at: Date;
  storage_key: string;
  scan_status: ScanStatus;
}

const COLUMNS = `fs.id, fs.folder_id, fs.workspace_id, fs.created_by, fs.created_at, fs.expires_at, fs.revoked_at,
                 fs.password_hash, fs.opens, fs.downloads, fs.last_accessed_at`;

/** Most items listed in one folder of a shared folder; the page says when there are more. */
export const FOLDER_LISTING_LIMIT = 500;

export const folderSharesRepo = {
  async insert(
    db: Db,
    share: {
      id: string;
      folderId: string;
      workspaceId: string;
      tokenHash: Buffer;
      createdBy: string;
      expiresAt: Date | null;
      passwordHash: string | null;
    },
  ): Promise<FolderShareRow> {
    const { rows } = await db.query<FolderShareRow>(
      `INSERT INTO folder_shares AS fs (id, folder_id, workspace_id, token_hash, created_by, expires_at, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        share.id,
        share.folderId,
        share.workspaceId,
        share.tokenHash,
        share.createdBy,
        share.expiresAt,
        share.passwordHash,
      ],
    );
    return rows[0]!;
  },

  /**
   * A link only while it is usable: not revoked, not expired, and its workspace not deleted.
   * Its folder existing is implied: deleting a folder deletes its links.
   */
  async resolveLive(db: Db, tokenHash: Buffer, now: Date): Promise<ResolvedFolderShare | null> {
    const { rows } = await db.query<ResolvedFolderShare>(
      `SELECT ${COLUMNS}, f.name AS folder_name
         FROM folder_shares fs
         JOIN folders f ON f.id = fs.folder_id
         JOIN workspaces w ON w.id = fs.workspace_id
        WHERE fs.token_hash = $1
          AND fs.revoked_at IS NULL
          AND (fs.expires_at IS NULL OR fs.expires_at > $2)
          AND w.deleted_at IS NULL`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  /** Whether a token belonged to a link at all, usable or not: tells 410 from 404. */
  async exists(db: Db, tokenHash: Buffer): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM folder_shares WHERE token_hash = $1', [tokenHash]);
    return (rowCount ?? 0) > 0;
  },

  async findById(db: Db, id: string): Promise<FolderShareRow | null> {
    const { rows } = await db.query<FolderShareRow>(`SELECT ${COLUMNS} FROM folder_shares fs WHERE fs.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async listForFolder(db: Db, folderId: string): Promise<FolderShareRow[]> {
    const { rows } = await db.query<FolderShareRow>(
      `SELECT ${COLUMNS} FROM folder_shares fs
        WHERE fs.folder_id = $1 AND fs.revoked_at IS NULL
        ORDER BY fs.created_at DESC`,
      [folderId],
    );
    return rows;
  },

  async revoke(db: Db, id: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      'UPDATE folder_shares SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, now],
    );
    return (rowCount ?? 0) > 0;
  },

  /** Counts one open or download; returns the opens so far. */
  async countAccess(db: Db, id: string, kind: 'open' | 'download', now: Date): Promise<number> {
    const { rows } = await db.query<{ opens: number }>(
      `UPDATE folder_shares
          SET opens = opens + CASE WHEN $2 = 'open' THEN 1 ELSE 0 END,
              downloads = downloads + CASE WHEN $2 = 'download' THEN 1 ELSE 0 END,
              last_accessed_at = $3
        WHERE id = $1
        RETURNING opens`,
      [id, kind, now],
    );
    return rows[0]?.opens ?? 0;
  },

  /** Wrong passwords inside the current window (0 once the window has passed). */
  async recentFailedUnlocks(db: Db, id: string, windowStart: Date): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT CASE WHEN failed_unlock_window >= $2 THEN failed_unlocks ELSE 0 END AS n
         FROM folder_shares WHERE id = $1`,
      [id, windowStart],
    );
    return rows[0]?.n ?? 0;
  },

  /** Records a wrong password, starting a new window if the last one has passed. One atomic update. */
  async recordFailedUnlock(db: Db, id: string, windowStart: Date, now: Date): Promise<void> {
    await db.query(
      `UPDATE folder_shares
          SET failed_unlocks = CASE WHEN failed_unlock_window >= $2 THEN failed_unlocks + 1 ELSE 1 END,
              failed_unlock_window = CASE WHEN failed_unlock_window >= $2 THEN failed_unlock_window ELSE $3 END
        WHERE id = $1`,
      [id, windowStart, now],
    );
  },

  /**
   * The chain of folders from the shared folder down to `folderId`, or null when `folderId` is
   * not the shared folder or below it. This is the check that keeps a recipient inside the
   * folder they were given.
   */
  async pathWithin(db: Db, rootId: string, folderId: string): Promise<Array<{ id: string; name: string }> | null> {
    const { rows } = await db.query<{ id: string; name: string; parent_id: string | null }>(
      `WITH RECURSIVE chain AS (
         SELECT f.id, f.name, f.parent_id, 0 AS depth FROM folders f WHERE f.id = $2
         UNION ALL
         SELECT p.id, p.name, p.parent_id, chain.depth + 1 FROM folders p
           JOIN chain ON p.id = chain.parent_id
          WHERE chain.depth < 32 AND chain.id <> $1
       )
       SELECT id, name, parent_id FROM chain ORDER BY depth DESC`,
      [rootId, folderId],
    );
    if (rows[0]?.id !== rootId) return null;
    return rows.map(({ id, name }) => ({ id, name }));
  },

  /** Subfolders of one folder, with how much each holds. */
  async subfolders(db: Db, folderId: string) {
    const { rows } = await db.query<{ id: string; name: string; document_count: string; folder_count: string }>(
      `SELECT f.id, f.name,
              (SELECT COUNT(*) FROM documents d
                WHERE d.folder_id = f.id AND d.deleted_at IS NULL AND d.scan_status IN ('clean', 'unscanned'))
                AS document_count,
              (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS folder_count
         FROM folders f WHERE f.parent_id = $1
        ORDER BY lower(f.name), f.id
        LIMIT $2`,
      [folderId, FOLDER_LISTING_LIMIT + 1],
    );
    return rows;
  },

  /**
   * Files in one folder that can be handed out: live, and cleared (or not needing) the malware
   * scan. Pending and infected files are simply not listed.
   */
  async documents(db: Db, folderId: string): Promise<SharedDocumentRow[]> {
    const { rows } = await db.query<SharedDocumentRow>(
      `SELECT id, filename, mime_type, size, created_at, storage_key, scan_status
         FROM documents
        WHERE folder_id = $1 AND deleted_at IS NULL AND scan_status IN ('clean', 'unscanned')
        ORDER BY lower(filename), id
        LIMIT $2`,
      [folderId, FOLDER_LISTING_LIMIT + 1],
    );
    return rows;
  },

  /** A live document inside the shared folder (at any depth), or null. */
  async documentWithin(db: Db, rootId: string, documentId: string): Promise<SharedDocumentRow | null> {
    const { rows } = await db.query<SharedDocumentRow>(
      `WITH RECURSIVE tree AS (
         SELECT id, 0 AS depth FROM folders WHERE id = $1
         UNION ALL
         SELECT c.id, tree.depth + 1 FROM folders c JOIN tree ON c.parent_id = tree.id WHERE tree.depth < 32
       )
       SELECT d.id, d.filename, d.mime_type, d.size, d.created_at, d.storage_key, d.scan_status
         FROM documents d
        WHERE d.id = $2 AND d.deleted_at IS NULL AND d.folder_id IN (SELECT id FROM tree)`,
      [rootId, documentId],
    );
    return rows[0] ?? null;
  },
};
