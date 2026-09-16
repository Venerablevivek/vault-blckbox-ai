import type { Db } from '../../db/pool';
import type { Role } from '../../types';

export interface WorkspaceRow {
  id: string;
  name: string;
  created_by: string;
  created_at: Date;
}

export interface MemberRow {
  user_id: string;
  email: string;
  role: Role;
  created_at: Date;
}

export const workspacesRepo = {
  async insertWorkspace(
    db: Db,
    workspace: { id: string; name: string; createdBy: string },
  ): Promise<WorkspaceRow> {
    const { rows } = await db.query<WorkspaceRow>(
      `INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [workspace.id, workspace.name, workspace.createdBy],
    );
    return rows[0]!;
  },

  /**
   * ON CONFLICT DO NOTHING makes membership insertion idempotent. The composite primary
   * key on (workspace_id, user_id) is what actually prevents duplicates; this just means
   * a repeated insert is a no-op instead of an error.
   */
  async insertMember(
    db: Db,
    member: { workspaceId: string; userId: string; role: Role },
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [member.workspaceId, member.userId, member.role],
    );
    return (rowCount ?? 0) > 0;
  },

  /** The authorization lookup. Runs on every workspace-scoped request. */
  async findMembership(db: Db, workspaceId: string, userId: string): Promise<Role | null> {
    const { rows } = await db.query<{ role: Role }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return rows[0]?.role ?? null;
  },

  async listForUser(
    db: Db,
    userId: string,
  ): Promise<Array<{ id: string; name: string; role: Role; created_at: Date }>> {
    const { rows } = await db.query<{ id: string; name: string; role: Role; created_at: Date }>(
      `SELECT w.id, w.name, m.role, w.created_at
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1
        ORDER BY w.created_at ASC`,
      [userId],
    );
    return rows;
  },

  async findById(db: Db, id: string): Promise<WorkspaceRow | null> {
    const { rows } = await db.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /**
   * Row-locks the workspace for the rest of the transaction.
   *
   * Two owners demoting each other at the same moment would each see "another owner
   * exists" and both succeed, leaving a workspace with nobody in charge. Serialising
   * ownership changes per workspace behind this lock makes the last-owner check sound.
   */
  async lockForUpdate(db: Db, workspaceId: string): Promise<void> {
    await db.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  },

  async countOwners(db: Db, workspaceId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = $1 AND role = 'OWNER'`,
      [workspaceId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  async updateRole(db: Db, workspaceId: string, userId: string, role: Role): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId, role],
    );
    return (rowCount ?? 0) > 0;
  },

  async deleteMember(db: Db, workspaceId: string, userId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return (rowCount ?? 0) > 0;
  },

  async rename(db: Db, workspaceId: string, name: string): Promise<void> {
    await db.query('UPDATE workspaces SET name = $2 WHERE id = $1', [workspaceId, name]);
  },

  async findUserEmail(db: Db, userId: string): Promise<string | null> {
    const { rows } = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    return rows[0]?.email ?? null;
  },

  async listMembers(db: Db, workspaceId: string): Promise<MemberRow[]> {
    const { rows } = await db.query<MemberRow>(
      `SELECT m.user_id, u.email, m.role, m.created_at
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY m.created_at ASC`,
      [workspaceId],
    );
    return rows;
  },
};
