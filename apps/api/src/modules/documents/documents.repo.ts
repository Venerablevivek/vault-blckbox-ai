import type { Db } from '../../db/pool';
import type { ScanStatus } from './scan-policy';

export interface DocumentRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  uploaded_by: string;
  filename: string;
  storage_key: string;
  mime_type: string;
  size: string; // bigint arrives as a string from pg
  created_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  /** SHA-256 of the stored bytes. Null only for rows created before checksums existed. */
  sha256: Buffer | null;
  scan_status: ScanStatus;
  scanned_at: Date | null;
  scan_signature: string | null;
  /** The current version's number; earlier versions are in document_versions. */
  version: number;
  /** Who uploaded the current version, and when; null for the original upload. */
  version_uploaded_by: string | null;
  version_created_at: Date | null;
}

export interface DocumentListRow extends DocumentRow {
  uploaded_by_email: string;
  deleted_by_email: string | null;
  /** Live (un-revoked) share links for this document. */
  link_count: string;
  /** Page views of those links. */
  opens: string;
  last_accessed_at: Date | null;
  /** Whether the person listing has starred it. */
  starred: boolean;
  /**
   * The value the list is sorted by, as PostgreSQL's own text form, echoed back to build the
   * next cursor. Text, not a JS Date: timestamps have microsecond precision and a Date keeps
   * only milliseconds, which made the cursor land between rows and repeat or skip them.
   */
  sort_value: string;
}

/** A live document to put in a zip, with the folder names between the archive root and it. */
export interface ArchiveRow {
  id: string;
  filename: string;
  storage_key: string;
  size: string;
  scan_status: ScanStatus;
  created_at: Date;
  dir: string[];
}

export type DocumentSort = 'date' | 'name' | 'size';
export type DocumentFilter = 'all' | 'shared' | 'mine' | 'starred' | 'recent';

export interface ListQuery {
  workspaceId: string;
  view: 'active' | 'trash';
  /** Folder to list. Ignored while searching, which covers the whole workspace. */
  folderId: string | null;
  search: string | null;
  filter: DocumentFilter;
  sort: DocumentSort;
  ascending: boolean;
  userId: string;
  limit: number;
  after: { value: string; id: string } | null;
}

/**
 * Sort keys. Each entry is a fixed SQL fragment selected by name from this table — never
 * text supplied by the client — so building the ORDER BY from it cannot inject SQL.
 */
const SORT_SQL: Record<DocumentSort | 'deleted' | 'recent', { expr: string; cast: string }> = {
  date: { expr: 'd.created_at', cast: 'timestamptz' },
  name: { expr: 'lower(d.filename)', cast: 'text' },
  size: { expr: 'd.size', cast: 'bigint' },
  deleted: { expr: 'd.deleted_at', cast: 'timestamptz' },
  recent: { expr: 'r.last_opened_at', cast: 'timestamptz' },
};

/** Escapes LIKE wildcards so a search for "50%" matches the text "50%", not everything. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const documentsRepo = {
  async insert(
    db: Db,
    doc: {
      id: string;
      workspaceId: string;
      folderId: string | null;
      uploadedBy: string;
      filename: string;
      storageKey: string;
      mimeType: string;
      size: number;
      /** Null for direct uploads: computed afterwards by a job, from the stored object. */
      sha256: Buffer | null;
      scanStatus: ScanStatus;
    },
  ): Promise<DocumentRow> {
    const { rows } = await db.query<DocumentRow>(
      `INSERT INTO documents (id, workspace_id, folder_id, uploaded_by, filename, storage_key, mime_type, size, sha256, scan_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        doc.id,
        doc.workspaceId,
        doc.folderId,
        doc.uploadedBy,
        doc.filename,
        doc.storageKey,
        doc.mimeType,
        doc.size,
        doc.sha256,
        doc.scanStatus,
      ],
    );
    return rows[0]!;
  },

  /** A live document in the workspace with identical content, other than `excludeId`. */
  async findByChecksum(
    db: Db,
    workspaceId: string,
    sha256: Buffer,
    excludeId: string,
  ): Promise<{ id: string; filename: string } | null> {
    const { rows } = await db.query<{ id: string; filename: string }>(
      `SELECT id, filename FROM documents
        WHERE workspace_id = $1 AND sha256 = $2 AND id <> $3 AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1`,
      [workspaceId, sha256, excludeId],
    );
    return rows[0] ?? null;
  },

  /** Any documents of a workspace, live or trashed, for purging a deleted workspace. */
  async anyInWorkspace(
    db: Db,
    workspaceId: string,
    limit: number,
  ): Promise<Array<{ id: string; storage_key: string }>> {
    const { rows } = await db.query<{ id: string; storage_key: string }>(
      'SELECT id, storage_key FROM documents WHERE workspace_id = $1 LIMIT $2',
      [workspaceId, limit],
    );
    return rows;
  },

  async findAnyById(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async deleteRow(db: Db, id: string): Promise<void> {
    await db.query('DELETE FROM documents WHERE id = $1', [id]);
  },

  async missingChecksums(db: Db, limit: number): Promise<Array<{ id: string; storage_key: string }>> {
    const { rows } = await db.query<{ id: string; storage_key: string }>(
      'SELECT id, storage_key FROM documents WHERE sha256 IS NULL ORDER BY created_at LIMIT $1',
      [limit],
    );
    return rows;
  },

  /**
   * Records a scan result, only if the document still holds the object that was scanned: a new
   * version uploaded meanwhile must be scanned itself, never inherit its predecessor's verdict.
   */
  async setScanResult(
    db: Db,
    id: string,
    storageKey: string,
    status: 'clean' | 'infected',
    signature: string | null,
    now: Date,
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE documents SET scan_status = $3, scan_signature = $4, scanned_at = $5
        WHERE id = $1 AND storage_key = $2 AND scan_status = 'pending'`,
      [id, storageKey, status, signature, now],
    );
    return (rowCount ?? 0) > 0;
  },

  /** Pending documents with no unfinished scan job: to be queued again (the scanner was down). */
  async pendingWithoutScanJob(db: Db, olderThanMinutes: number, limit: number): Promise<Array<{ id: string }>> {
    // created_at is set by the database clock, so the cutoff uses it too.
    const { rows } = await db.query<{ id: string }>(
      `SELECT d.id FROM documents d
        WHERE d.scan_status = 'pending' AND d.created_at < now() - make_interval(mins => $1)
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.queue = 'document.scan' AND j.dedupe_key = d.id::text
                            AND j.status IN ('queued', 'running'))
        ORDER BY d.created_at LIMIT $2`,
      [olderThanMinutes, limit],
    );
    return rows;
  },

  /** Stores a computed checksum, only if the document still holds the object it was computed from. */
  async setChecksum(db: Db, id: string, storageKey: string, sha256: Buffer): Promise<void> {
    await db.query('UPDATE documents SET sha256 = $3 WHERE id = $1 AND storage_key = $2 AND sha256 IS NULL', [
      id,
      storageKey,
      sha256,
    ]);
  },

  /**
   * One page of documents, keyset-paginated.
   *
   * Pages are cut on (sort value, id) rather than OFFSET, so rows inserted or trashed while
   * someone scrolls never cause a duplicate or a skipped row, and later pages stay as fast
   * as the first. Every parameter is bound; the only non-parameter SQL is chosen from
   * SORT_SQL above.
   */
  async list(db: Db, q: ListQuery): Promise<DocumentListRow[]> {
    const trash = q.view === 'trash';
    const recent = !trash && q.filter === 'recent';
    // Recent is always most recently opened first; its own ordering replaces the chosen sort.
    const sort = SORT_SQL[trash ? 'deleted' : recent ? 'recent' : q.sort];
    const ascending = trash || recent ? false : q.ascending;
    const direction = ascending ? 'ASC' : 'DESC';
    const comparator = ascending ? '>' : '<';

    const where: string[] = ['d.workspace_id = $1'];
    const params: unknown[] = [q.workspaceId, q.userId];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    where.push(trash ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL');

    if (q.search) {
      where.push(`d.filename ILIKE ${bind(`%${escapeLike(q.search)}%`)}`);
    } else if (!trash && q.filter === 'all') {
      // Only the plain view is per folder; search and the filters (shared, mine, starred,
      // recent) cover the whole workspace, matching their tab counts.
      where.push(`d.folder_id IS NOT DISTINCT FROM ${bind(q.folderId)}::uuid`);
    }

    if (!trash && q.filter === 'mine') where.push(`d.uploaded_by = $2`);
    if (!trash && q.filter === 'starred') {
      where.push(`EXISTS (SELECT 1 FROM document_stars st WHERE st.document_id = d.id AND st.user_id = $2)`);
    }
    if (!trash && q.filter === 'shared') {
      where.push(`EXISTS (SELECT 1 FROM shares s WHERE s.document_id = d.id AND s.revoked_at IS NULL)`);
    }

    if (q.after) {
      where.push(
        `(${sort.expr}, d.id) ${comparator} (${bind(q.after.value)}::${sort.cast}, ${bind(q.after.id)}::uuid)`,
      );
    }

    const limit = bind(q.limit);
    const { rows } = await db.query<DocumentListRow>(
      `SELECT d.*,
              (${sort.expr})::text AS sort_value,
              u.email  AS uploaded_by_email,
              du.email AS deleted_by_email,
              COALESCE(l.link_count, 0) AS link_count,
              COALESCE(l.opens, 0)      AS opens,
              l.last_accessed_at,
              EXISTS (SELECT 1 FROM document_stars st WHERE st.document_id = d.id AND st.user_id = $2) AS starred
         FROM documents d
         ${recent ? 'JOIN document_recents r ON r.document_id = d.id AND r.user_id = $2' : ''}
         JOIN users u ON u.id = d.uploaded_by
         LEFT JOIN users du ON du.id = d.deleted_by
         LEFT JOIN LATERAL (
           -- Read from the links' counters: the cost no longer grows with how often links are used.
           SELECT COUNT(*) AS link_count,
                  SUM(sh.open_count) AS opens,
                  MAX(sh.last_accessed_at) AS last_accessed_at
             FROM shares sh
            WHERE sh.document_id = d.id AND sh.revoked_at IS NULL
         ) l ON true
        WHERE ${where.join(' AND ')}
        ORDER BY ${sort.expr} ${direction}, d.id ${direction}
        LIMIT ${limit}`,
      params,
    );
    return rows;
  },

  /** Tab counts for the active view, across the whole workspace. */
  async counts(db: Db, workspaceId: string, userId: string) {
    const { rows } = await db.query<{ all: string; shared: string; mine: string; starred: string; trash: string }>(
      `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL) AS all,
              COUNT(*) FILTER (WHERE deleted_at IS NULL AND EXISTS (
                SELECT 1 FROM shares s WHERE s.document_id = documents.id AND s.revoked_at IS NULL)) AS shared,
              COUNT(*) FILTER (WHERE deleted_at IS NULL AND uploaded_by = $2) AS mine,
              COUNT(*) FILTER (WHERE deleted_at IS NULL AND EXISTS (
                SELECT 1 FROM document_stars st WHERE st.document_id = documents.id AND st.user_id = $2)) AS starred,
              COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS trash
         FROM documents WHERE workspace_id = $1`,
      [workspaceId, userId],
    );
    const r = rows[0]!;
    return {
      all: Number(r.all),
      shared: Number(r.shared),
      mine: Number(r.mine),
      starred: Number(r.starred),
      trash: Number(r.trash),
    };
  },

  async setStar(db: Db, userId: string, documentId: string, starred: boolean): Promise<void> {
    if (starred) {
      await db.query('INSERT INTO document_stars (user_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        userId,
        documentId,
      ]);
    } else {
      await db.query('DELETE FROM document_stars WHERE user_id = $1 AND document_id = $2', [userId, documentId]);
    }
  },

  async touchRecent(db: Db, userId: string, documentId: string, at: Date): Promise<void> {
    await db.query(
      `INSERT INTO document_recents (user_id, document_id, last_opened_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, document_id) DO UPDATE SET last_opened_at = GREATEST(document_recents.last_opened_at, $3)`,
      [userId, documentId, at],
    );
  },

  /**
   * Looks a document up by id alone. The caller is authorized against the workspace on
   * the returned row before anything is returned to them — see authorizeById.
   */
  /**
   * Live documents chosen by id, flat. At most `limit` rows; callers ask for one more than
   * they allow, to tell "exactly the limit" from "too many".
   */
  async archiveByIds(db: Db, workspaceId: string, ids: string[], limit: number): Promise<ArchiveRow[]> {
    const { rows } = await db.query<ArchiveRow>(
      `SELECT d.id, d.filename, d.storage_key, d.size, d.scan_status, d.created_at, ARRAY[]::text[] AS dir
         FROM documents d
        WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND d.id = ANY($2::uuid[])
        ORDER BY d.filename, d.id
        LIMIT $3`,
      [workspaceId, ids, limit],
    );
    return rows;
  },

  /** Every live document in a folder and its subfolders, with each one's path below it. */
  async archiveFolder(db: Db, workspaceId: string, folderId: string, limit: number): Promise<ArchiveRow[]> {
    const { rows } = await db.query<ArchiveRow>(
      `WITH RECURSIVE tree AS (
         SELECT f.id, ARRAY[]::text[] AS dir, 0 AS depth
           FROM folders f WHERE f.id = $2 AND f.workspace_id = $1
         UNION ALL
         SELECT c.id, tree.dir || c.name::text, tree.depth + 1
           FROM folders c JOIN tree ON c.parent_id = tree.id
          WHERE tree.depth < 32
       )
       SELECT d.id, d.filename, d.storage_key, d.size, d.scan_status, d.created_at, tree.dir
         FROM documents d JOIN tree ON d.folder_id = tree.id
        WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
        ORDER BY tree.dir, d.filename, d.id
        LIMIT $3`,
      [workspaceId, folderId, limit],
    );
    return rows;
  },

  async findLiveById(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] ?? null;
  },

  async findTrashedById(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NOT NULL`, [
      id,
    ]);
    return rows[0] ?? null;
  },

  async update(db: Db, id: string, changes: { filename?: string; folderId?: string | null }): Promise<DocumentRow> {
    const { rows } = await db.query<DocumentRow>(
      `UPDATE documents
          SET filename  = COALESCE($2, filename),
              folder_id = CASE WHEN $3 THEN $4::uuid ELSE folder_id END
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, changes.filename ?? null, changes.folderId !== undefined, changes.folderId ?? null],
    );
    return rows[0]!;
  },

  /**
   * Moves a document to the trash. Returns the row only if this call trashed it, so a
   * double request cannot revoke links or write the audit entry twice.
   */
  async trash(db: Db, id: string, userId: string, now: Date): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `UPDATE documents SET deleted_at = $2, deleted_by = $3
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, now, userId],
    );
    return rows[0] ?? null;
  },

  async restore(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `UPDATE documents SET deleted_at = NULL, deleted_by = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  /** Deletes a trashed row. Returns its size so the caller can release the quota, or null if already gone. */
  /**
   * Deletes a trashed document and its earlier versions (by cascade). Returns the bytes this
   * gives back to the quota: every version's, except a quarantined current version, whose bytes
   * were released when malware was found.
   */
  async hardDelete(db: Db, id: string): Promise<{ workspace_id: string; size: string } | null> {
    const { rows } = await db.query<{ workspace_id: string; size: string }>(
      `WITH history AS (SELECT COALESCE(SUM(size), 0) AS bytes FROM document_versions WHERE document_id = $1)
       DELETE FROM documents WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING workspace_id,
                 ((CASE WHEN scan_status = 'infected' THEN 0 ELSE size END) + (SELECT bytes FROM history))::text AS size`,
      [id],
    );
    return rows[0] ?? null;
  },

  /** Trashed documents past retention, oldest first, for the cleanup job. */
  async expiredTrash(db: Db, before: Date, limit: number): Promise<DocumentRow[]> {
    const { rows } = await db.query<DocumentRow>(
      `SELECT * FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < $1
        ORDER BY deleted_at LIMIT $2`,
      [before, limit],
    );
    return rows;
  },
};
