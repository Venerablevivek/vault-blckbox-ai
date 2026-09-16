import type { Db } from '../../db/pool';

/** Every action the trail can record. A union, so a typo is a compile error. */
export type AuditAction =
  | 'workspace.created'
  | 'document.uploaded'
  | 'document.downloaded'
  | 'document.deleted'
  | 'share.created'
  | 'share.revoked'
  | 'share.accessed'
  | 'share.blocked'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed'
  | 'member.left'
  | 'member.role_changed'
  | 'invitation.revoked'
  | 'document.renamed'
  | 'document.previewed'
  | 'workspace.renamed';

export type AuditResource = 'workspace' | 'document' | 'share' | 'member' | 'invitation';

export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: AuditAction;
  resource_type: AuditResource;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export const auditRepo = {
  async insert(
    db: Db,
    entry: {
      id: string;
      workspaceId: string;
      actorUserId: string | null;
      action: AuditAction;
      resourceType: AuditResource;
      resourceId: string | null;
      metadata: Record<string, unknown>;
      at: Date;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_events
         (id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        entry.workspaceId,
        entry.actorUserId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        JSON.stringify(entry.metadata),
        entry.at,
      ],
    );
  },

  /**
   * Activity feed for one workspace, newest first.
   *
   * The actor's email is joined at read time rather than stored, so a changed address is
   * reflected everywhere — but `metadata` keeps a snapshot of the subject (a filename, an
   * invited address) because that subject may no longer exist.
   */
  async listForWorkspace(
    db: Db,
    workspaceId: string,
    options: { limit: number; before?: Date },
  ): Promise<AuditRow[]> {
    const { rows } = await db.query<AuditRow>(
      `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action,
              a.resource_type, a.resource_id, a.metadata, a.created_at
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.workspace_id = $1
          AND ($2::timestamptz IS NULL OR a.created_at < $2)
        ORDER BY a.created_at DESC
        LIMIT $3`,
      [workspaceId, options.before ?? null, options.limit],
    );
    return rows;
  },
};
