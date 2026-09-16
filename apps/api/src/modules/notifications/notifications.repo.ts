import type { Db } from '../../db/pool';

export type NotificationType =
  | 'share.first_open'
  | 'share.new_viewer'
  | 'share.forwarding_suspected'
  | 'document.uploaded'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed';

export interface NotificationRow {
  id: string;
  workspace_id: string | null;
  type: NotificationType;
  title: string;
  body: string | null;
  resource_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

export const notificationsRepo = {
  async insert(
    db: Db,
    notification: {
      id: string;
      userId: string;
      workspaceId: string | null;
      type: NotificationType;
      title: string;
      body: string | null;
      resourceId: string | null;
      at: Date;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO notifications
         (id, user_id, workspace_id, type, title, body, resource_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        notification.id,
        notification.userId,
        notification.workspaceId,
        notification.type,
        notification.title,
        notification.body,
        notification.resourceId,
        notification.at,
      ],
    );
  },

  async listForUser(db: Db, userId: string, limit: number): Promise<NotificationRow[]> {
    const { rows } = await db.query<NotificationRow>(
      `SELECT id, workspace_id, type, title, body, resource_id, read_at, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows;
  },

  /** Backs the unread badge. Hits the partial index, so it stays cheap under polling. */
  async unreadCount(db: Db, userId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  /** user_id is in the WHERE clause, so one user can never mark another's as read. */
  async markRead(db: Db, userId: string, at: Date, id?: string): Promise<void> {
    if (id) {
      await db.query(
        `UPDATE notifications SET read_at = $3
          WHERE user_id = $1 AND id = $2 AND read_at IS NULL`,
        [userId, id, at],
      );
      return;
    }
    await db.query(
      `UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL`,
      [userId, at],
    );
  },

  /** Everyone in a workspace except the person who caused the event. */
  async recipientsFor(db: Db, workspaceId: string, exceptUserId: string): Promise<string[]> {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id <> $2`,
      [workspaceId, exceptUserId],
    );
    return rows.map((row) => row.user_id);
  },
};
