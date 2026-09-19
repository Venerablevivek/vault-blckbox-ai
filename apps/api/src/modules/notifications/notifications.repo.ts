import type { Db } from '../../db/pool';

export type NotificationType =
  | 'share.first_open'
  | 'share.new_viewer'
  | 'share.forwarding_suspected'
  | 'document.uploaded'
  | 'document.commented'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed'
  | 'workspace.deleted'
  | 'document.quarantined';

/**
 * Types that can't be muted: each tells someone about their own access or their own files
 * (malware found, removed from a workspace, a role change, a workspace deleted, a link that
 * looks forwarded), which they must not miss.
 */
export const ESSENTIAL_TYPES: readonly NotificationType[] = [
  'share.forwarding_suspected',
  'member.removed',
  'member.role_changed',
  'workspace.deleted',
  'document.quarantined',
];

export type DigestFrequency = 'off' | 'daily' | 'weekly';

export interface Preferences {
  digest: DigestFrequency;
  instant: NotificationType[];
  muted: NotificationType[];
}

export const DEFAULT_PREFERENCES: Preferences = { digest: 'off', instant: [], muted: [] };

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

/**
 * A notification about a workspace is only shown while the user is still a member of it.
 * Someone who has been removed stops seeing earlier notifications that name its documents.
 * Notifications with no workspace (such as "you were removed") are always shown.
 */
const VISIBLE = `(n.workspace_id IS NULL OR EXISTS (
  SELECT 1 FROM workspace_members m WHERE m.workspace_id = n.workspace_id AND m.user_id = n.user_id))`;

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
      `SELECT n.id, n.workspace_id, n.type, n.title, n.body, n.resource_id, n.read_at, n.created_at
         FROM notifications n
        WHERE n.user_id = $1
          AND ${VISIBLE}
        ORDER BY n.created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows;
  },

  /** Backs the unread badge. Hits the partial index, so it stays cheap under polling. */
  async unreadCount(db: Db, userId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM notifications n
        WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE}`,
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
    await db.query(`UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL`, [userId, at]);
  },

  /** Everyone in a workspace except the person who caused the event. */
  async preferences(db: Db, userId: string): Promise<Preferences> {
    const { rows } = await db.query<Preferences>(
      'SELECT digest, instant, muted FROM notification_preferences WHERE user_id = $1',
      [userId],
    );
    return rows[0] ?? DEFAULT_PREFERENCES;
  },

  async savePreferences(db: Db, userId: string, preferences: Preferences, now: Date): Promise<void> {
    await db.query(
      `INSERT INTO notification_preferences (user_id, digest, instant, muted, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET digest = EXCLUDED.digest, instant = EXCLUDED.instant, muted = EXCLUDED.muted,
             updated_at = EXCLUDED.updated_at`,
      [userId, preferences.digest, preferences.instant, preferences.muted, now],
    );
  },

  /**
   * For each recipient: whether a notification of `type` is muted, and the verified address to
   * email it to when they asked for it right away (null otherwise). Unverified addresses are
   * never emailed.
   */
  async deliveryFor(
    db: Db,
    userIds: string[],
    type: NotificationType,
  ): Promise<Map<string, { muted: boolean; email: string | null }>> {
    const { rows } = await db.query<{ id: string; muted: boolean; email: string | null }>(
      `SELECT u.id,
              COALESCE($2 = ANY (p.muted), false) AS muted,
              CASE WHEN $2 = ANY (p.instant) AND u.email_verified_at IS NOT NULL THEN u.email END AS email
         FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id
        WHERE u.id = ANY ($1::uuid[])`,
      [userIds, type],
    );
    return new Map(rows.map((r) => [r.id, { muted: r.muted, email: r.email }]));
  },

  /** People due a digest: their frequency's interval has passed since the last one, and their address is verified. */
  async dueDigests(db: Db, now: Date, limit: number) {
    const { rows } = await db.query<{ user_id: string; email: string; digest: 'daily' | 'weekly' }>(
      `SELECT p.user_id, u.email, p.digest
         FROM notification_preferences p JOIN users u ON u.id = p.user_id
        WHERE p.digest <> 'off'
          AND u.email_verified_at IS NOT NULL
          AND (p.last_digest_at IS NULL OR p.last_digest_at <= $1::timestamptz -
                 (CASE p.digest WHEN 'daily' THEN interval '1 day' ELSE interval '7 days' END))
        LIMIT $2`,
      [now, limit],
    );
    return rows;
  },

  /**
   * Marks every unread, visible notification not yet in a digest as digested, and returns exactly
   * those rows (newest first): what is marked is what is reported, with no gap for a notification
   * written in between.
   */
  async takeForDigest(db: Db, userId: string, now: Date) {
    const { rows } = await db.query<NotificationRow & { workspace_name: string | null }>(
      `UPDATE notifications n SET digested_at = $2
        WHERE n.user_id = $1 AND n.read_at IS NULL AND n.digested_at IS NULL AND ${VISIBLE}
        RETURNING n.id, n.workspace_id, n.type, n.title, n.body, n.resource_id, n.read_at, n.created_at,
                  (SELECT w.name FROM workspaces w WHERE w.id = n.workspace_id) AS workspace_name`,
      [userId, now],
    );
    return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
  },

  async markDigestSent(db: Db, userId: string, at: Date): Promise<void> {
    await db.query('UPDATE notification_preferences SET last_digest_at = $2 WHERE user_id = $1', [userId, at]);
  },

  async recipientsFor(db: Db, workspaceId: string, exceptUserId: string): Promise<string[]> {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id <> $2`,
      [workspaceId, exceptUserId],
    );
    return rows.map((row) => row.user_id);
  },
};
