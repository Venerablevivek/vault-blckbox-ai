import type { Db } from '../../db/pool';

export interface CommentRow {
  id: string;
  document_id: string;
  workspace_id: string;
  author_id: string;
  author_email: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
}

const SELECT = `SELECT c.id, c.document_id, c.workspace_id, c.author_id, u.email AS author_email, c.body,
                       c.created_at, c.edited_at
                  FROM document_comments c
                  JOIN users u ON u.id = c.author_id`;

export const commentsRepo = {
  /** A document's thread, oldest first. */
  async list(db: Db, documentId: string, limit: number): Promise<CommentRow[]> {
    const { rows } = await db.query<CommentRow>(`${SELECT} WHERE c.document_id = $1 ORDER BY c.seq LIMIT $2`, [
      documentId,
      limit,
    ]);
    return rows;
  },

  async find(db: Db, documentId: string, commentId: string): Promise<CommentRow | null> {
    const { rows } = await db.query<CommentRow>(`${SELECT} WHERE c.document_id = $1 AND c.id = $2`, [
      documentId,
      commentId,
    ]);
    return rows[0] ?? null;
  },

  async count(db: Db, documentId: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM document_comments WHERE document_id = $1',
      [documentId],
    );
    return Number(rows[0]?.n ?? 0);
  },

  async insert(
    db: Db,
    row: { id: string; documentId: string; workspaceId: string; authorId: string; body: string; at: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO document_comments (id, document_id, workspace_id, author_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.documentId, row.workspaceId, row.authorId, row.body, row.at],
    );
  },

  async update(db: Db, commentId: string, body: string, at: Date): Promise<void> {
    await db.query('UPDATE document_comments SET body = $2, edited_at = $3 WHERE id = $1', [commentId, body, at]);
  },

  async remove(db: Db, commentId: string): Promise<void> {
    await db.query('DELETE FROM document_comments WHERE id = $1', [commentId]);
  },

  /**
   * Who hears about a new comment: the person who uploaded the document and everyone who has
   * commented on it, if they are still members, never the author themselves.
   */
  async participants(db: Db, documentId: string, workspaceId: string, exceptUserId: string): Promise<string[]> {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT DISTINCT p.user_id
         FROM (SELECT uploaded_by AS user_id FROM documents WHERE id = $1
               UNION
               SELECT author_id FROM document_comments WHERE document_id = $1) p
         JOIN workspace_members m ON m.user_id = p.user_id AND m.workspace_id = $2
        WHERE p.user_id <> $3`,
      [documentId, workspaceId, exceptUserId],
    );
    return rows.map((r) => r.user_id);
  },
};
