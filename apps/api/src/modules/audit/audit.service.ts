import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../../db/pool';
import type { Clock } from '../../types';
import { auditRepo, type AuditAction, type AuditResource } from './audit.repo';

export interface AuditEntry {
  workspaceId: string;
  actorUserId: string | null;
  action: AuditAction;
  resourceType: AuditResource;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export function createAuditService(deps: { pool: Pool; clock: Clock; logger: Logger }) {
  const { pool, clock, logger } = deps;

  function toRow(entry: AuditEntry) {
    return {
      id: randomUUID(),
      workspaceId: entry.workspaceId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      metadata: entry.metadata ?? {},
      at: clock.now(),
    };
  }

  return {
    /**
     * Awaited write, for state-changing actions.
     *
     * Accepts an optional transaction so an audit entry can be committed atomically with
     * the thing it describes — "member joined" and the membership row land together or
     * not at all.
     */
    async record(entry: AuditEntry, tx?: Db): Promise<void> {
      await auditRepo.insert(tx ?? pool, toRow(entry));
    },

    /**
     * Fire-and-forget, for high-volume read events (downloads, anonymous share access).
     *
     * A failure to write the trail must never fail the request that caused it: the user is
     * entitled to the document either way. The trade is that under a database outage the
     * trail can lose entries, which is the right trade for reads and the wrong one for
     * mutations — hence two methods rather than one.
     */
    recordAsync(entry: AuditEntry): void {
      void auditRepo.insert(pool, toRow(entry)).catch((error: unknown) => {
        logger.warn({ err: error, action: entry.action }, 'failed to write audit event');
      });
    },

    async list(workspaceId: string, options: { limit?: number; before?: Date } = {}) {
      const rows = await auditRepo.listForWorkspace(pool, workspaceId, {
        limit: Math.min(options.limit ?? 50, 200),
        before: options.before,
      });
      return rows.map((row) => ({
        id: row.id,
        actorEmail: row.actor_email,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        metadata: row.metadata,
        createdAt: row.created_at,
      }));
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
