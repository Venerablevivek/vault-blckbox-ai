import type { Db } from '../../db/pool';
import { chainHash } from './audit-chain';

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
  | 'document.moved'
  | 'document.trashed'
  | 'document.restored'
  | 'document.purged'
  | 'folder.created'
  | 'folder.renamed'
  | 'folder.moved'
  | 'folder.deleted'
  | 'share.updated'
  | 'workspace.renamed'
  | 'document.quarantined';

export type AuditResource = 'workspace' | 'document' | 'folder' | 'share' | 'member' | 'invitation';

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

export interface ChainRow {
  seq: string;
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: unknown;
  created_at: Date;
  prev_hash: Buffer | null;
  hash: Buffer | null;
}

export const auditRepo = {
  /**
   * Appends an event to its workspace's hash chain. Must run inside a transaction: the advisory
   * lock serialises writers per workspace, so two events can't both chain to the same predecessor.
   */
  async insertChained(
    tx: Db,
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
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('audit:' || $1::text, 0))`, [entry.workspaceId]);
    const { rows } = await tx.query<{ hash: Buffer }>(
      `SELECT hash FROM audit_events WHERE workspace_id = $1 AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      [entry.workspaceId],
    );
    const previous = rows[0]?.hash ?? null;
    // Round-trip the metadata through JSON first, so the hash covers exactly what jsonb stores
    // (undefined values dropped, dates as strings).
    const metadata = JSON.parse(JSON.stringify(entry.metadata)) as Record<string, unknown>;
    const hash = chainHash(previous, {
      id: entry.id,
      workspaceId: entry.workspaceId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      metadata,
      createdAt: entry.at,
    });
    await tx.query(
      `INSERT INTO audit_events
         (id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata, created_at, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.id,
        entry.workspaceId,
        entry.actorUserId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        JSON.stringify(metadata),
        entry.at,
        previous,
        hash,
      ],
    );
  },

  /** A page of the chain in order, for verification. */
  async chainPage(db: Db, workspaceId: string, afterSeq: string, limit: number): Promise<ChainRow[]> {
    const { rows } = await db.query<ChainRow>(
      `SELECT seq, id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata, created_at, prev_hash, hash
         FROM audit_events WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [workspaceId, afterSeq, limit],
    );
    return rows;
  },

  /**
   * Activity feed for one workspace, newest first.
   *
   * The actor's email is joined at read time rather than stored, so a changed address is
   * reflected everywhere — but `metadata` keeps a snapshot of the subject (a filename, an
   * invited address) because that subject may no longer exist.
   */
  async listForWorkspace(db: Db, workspaceId: string, options: { limit: number; before?: Date }): Promise<AuditRow[]> {
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
