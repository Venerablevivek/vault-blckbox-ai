import type { Db } from '../../db/pool';

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
}

export interface DocumentListRow extends DocumentRow {
  uploaded_by_email: string;
  deleted_by_email: string | null;
  /** Live (un-revoked) share links for this document. */
  link_count: string;
  /** Page views of those links. */
  opens: string;
  last_accessed_at: Date | null;
  /**
   * The value the list is sorted by, as PostgreSQL's own text form, echoed back to build the
   * next cursor. Text, not a JS Date: timestamps have microsecond precision and a Date keeps
   * only milliseconds, which made the cursor land between rows and repeat or skip them.
   */
  sort_value: string;
}

export type DocumentSort = 'date' | 'name' | 'size';
export type DocumentFilter = 'all' | 'shared' | 'mine';

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
const SORT_SQL: Record<DocumentSort | 'deleted', { expr: string; cast: string }> = {
  date: { expr: 'd.created_at', cast: 'timestamptz' },
  name: { expr: 'lower(d.filename)', cast: 'text' },
  size: { expr: 'd.size', cast: 'bigint' },
  deleted: { expr: 'd.deleted_at', cast: 'timestamptz' },
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
    },
  ): Promise<DocumentRow> {
    const { rows } = await db.query<DocumentRow>(
      `INSERT INTO documents (id, workspace_id, folder_id, uploaded_by, filename, storage_key, mime_type, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [doc.id, doc.workspaceId, doc.folderId, doc.uploadedBy, doc.filename, doc.storageKey, doc.mimeType, doc.size],
    );
    return rows[0]!;
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
    const sort = SORT_SQL[trash ? 'deleted' : q.sort];
    const ascending = trash ? false : q.ascending;
    const direction = ascending ? 'ASC' : 'DESC';
    const comparator = ascending ? '>' : '<';

    const where: string[] = ['d.workspace_id = $1'];
    const params: unknown[] = [q.workspaceId];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    where.push(trash ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL');

    if (q.search) {
      where.push(`d.filename ILIKE ${bind(`%${escapeLike(q.search)}%`)}`);
    } else if (!trash) {
      where.push(`d.folder_id IS NOT DISTINCT FROM ${bind(q.folderId)}::uuid`);
    }

    if (!trash && q.filter === 'mine') where.push(`d.uploaded_by = ${bind(q.userId)}`);
    if (!trash && q.filter === 'shared') {
      where.push(`EXISTS (SELECT 1 FROM shares s WHERE s.document_id = d.id AND s.revoked_at IS NULL)`);
    }

    if (q.after) {
      where.push(`(${sort.expr}, d.id) ${comparator} (${bind(q.after.value)}::${sort.cast}, ${bind(q.after.id)}::uuid)`);
    }

    const limit = bind(q.limit);
    const { rows } = await db.query<DocumentListRow>(
      `SELECT d.*,
              (${sort.expr})::text AS sort_value,
              u.email  AS uploaded_by_email,
              du.email AS deleted_by_email,
              COALESCE(l.link_count, 0) AS link_count,
              COALESCE(l.opens, 0)      AS opens,
              l.last_accessed_at
         FROM documents d
         JOIN users u ON u.id = d.uploaded_by
         LEFT JOIN users du ON du.id = d.deleted_by
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT sh.id) AS link_count,
                  COUNT(e.id) FILTER (WHERE e.outcome = 'resolved') AS opens,
                  MAX(e.accessed_at) FILTER (WHERE e.outcome IN ('resolved','downloaded')) AS last_accessed_at
             FROM shares sh
             LEFT JOIN share_access_events e ON e.share_id = sh.id
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
    const { rows } = await db.query<{ all: string; shared: string; mine: string; trash: string }>(
      `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL) AS all,
              COUNT(*) FILTER (WHERE deleted_at IS NULL AND EXISTS (
                SELECT 1 FROM shares s WHERE s.document_id = documents.id AND s.revoked_at IS NULL)) AS shared,
              COUNT(*) FILTER (WHERE deleted_at IS NULL AND uploaded_by = $2) AS mine,
              COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS trash
         FROM documents WHERE workspace_id = $1`,
      [workspaceId, userId],
    );
    const r = rows[0]!;
    return { all: Number(r.all), shared: Number(r.shared), mine: Number(r.mine), trash: Number(r.trash) };
  },

  /**
   * Looks a document up by id alone. The caller is authorized against the workspace on
   * the returned row before anything is returned to them — see authorizeById.
   */
  async findLiveById(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  async findTrashedById(db: Db, id: string): Promise<DocumentRow | null> {
    const { rows } = await db.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id],
    );
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

  async hardDelete(db: Db, id: string): Promise<void> {
    await db.query('DELETE FROM documents WHERE id = $1 AND deleted_at IS NOT NULL', [id]);
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
