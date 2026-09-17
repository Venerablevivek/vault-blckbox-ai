import type { Db } from '../../db/pool';

export interface FolderRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  created_by: string | null;
  created_at: Date;
}

/** Folders never nest deeper than this. Keeps breadcrumbs readable and ancestor walks bounded. */
export const MAX_FOLDER_DEPTH = 8;

export const foldersRepo = {
  async insert(
    db: Db,
    folder: { id: string; workspaceId: string; parentId: string | null; name: string; createdBy: string },
  ): Promise<FolderRow> {
    const { rows } = await db.query<FolderRow>(
      `INSERT INTO folders (id, workspace_id, parent_id, name, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [folder.id, folder.workspaceId, folder.parentId, folder.name, folder.createdBy],
    );
    return rows[0]!;
  },

  /** Workspace-scoped lookup: a folder id from another workspace matches nothing. */
  async findInWorkspace(db: Db, workspaceId: string, id: string): Promise<FolderRow | null> {
    const { rows } = await db.query<FolderRow>('SELECT * FROM folders WHERE id = $1 AND workspace_id = $2', [
      id,
      workspaceId,
    ]);
    return rows[0] ?? null;
  },

  async findById(db: Db, id: string): Promise<FolderRow | null> {
    const { rows } = await db.query<FolderRow>('SELECT * FROM folders WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /** Children of a folder, or root folders when parentId is null, with their live contents. */
  async listChildren(
    db: Db,
    workspaceId: string,
    parentId: string | null,
  ): Promise<Array<FolderRow & { document_count: string; folder_count: string }>> {
    const { rows } = await db.query<FolderRow & { document_count: string; folder_count: string }>(
      `SELECT f.*,
              (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS folder_count
         FROM folders f
        WHERE f.workspace_id = $1 AND f.parent_id IS NOT DISTINCT FROM $2
        ORDER BY lower(f.name)`,
      [workspaceId, parentId],
    );
    return rows;
  },

  /**
   * The folder and its ancestors, root first, for breadcrumbs and cycle checks.
   * The depth guard stops the walk even if bad data ever formed a loop.
   */
  async pathTo(db: Db, workspaceId: string, id: string): Promise<FolderRow[]> {
    const { rows } = await db.query<FolderRow & { depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT f.*, 0 AS depth FROM folders f WHERE f.id = $1 AND f.workspace_id = $2
         UNION ALL
         SELECT p.*, chain.depth + 1 FROM folders p
           JOIN chain ON p.id = chain.parent_id
          WHERE chain.depth < 32
       )
       SELECT * FROM chain ORDER BY depth DESC`,
      [id, workspaceId],
    );
    return rows;
  },

  /** How many levels exist below a folder (0 when it has no subfolders). */
  async subtreeHeight(db: Db, id: string): Promise<number> {
    const { rows } = await db.query<{ height: number }>(
      `WITH RECURSIVE tree AS (
         SELECT id, 0 AS depth FROM folders WHERE id = $1
         UNION ALL
         SELECT c.id, tree.depth + 1 FROM folders c JOIN tree ON c.parent_id = tree.id WHERE tree.depth < 32
       )
       SELECT COALESCE(MAX(depth), 0) AS height FROM tree`,
      [id],
    );
    return Number(rows[0]?.height ?? 0);
  },

  async update(db: Db, id: string, changes: { name?: string; parentId?: string | null }): Promise<FolderRow> {
    const { rows } = await db.query<FolderRow>(
      `UPDATE folders
          SET name = COALESCE($2, name),
              parent_id = CASE WHEN $3 THEN $4::uuid ELSE parent_id END
        WHERE id = $1
        RETURNING *`,
      [id, changes.name ?? null, changes.parentId !== undefined, changes.parentId ?? null],
    );
    return rows[0]!;
  },

  /** Live documents and subfolders directly inside. Trashed documents do not count. */
  async isEmpty(db: Db, id: string): Promise<boolean> {
    const { rows } = await db.query<{ busy: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM documents WHERE folder_id = $1 AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM folders WHERE parent_id = $1) AS busy`,
      [id],
    );
    return !rows[0]?.busy;
  },

  async delete(db: Db, id: string): Promise<void> {
    await db.query('DELETE FROM folders WHERE id = $1', [id]);
  },
};
