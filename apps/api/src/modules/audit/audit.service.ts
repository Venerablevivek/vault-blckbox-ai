import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../../db/pool';
import { withTenant } from '../../db/tenant';
import { withTransaction } from '../../db/tx';
import { chainHash } from './audit-chain';
import type { Clock } from '../../types';
import { auditRepo, type AuditAction, type AuditFilter, type AuditResource, type AuditRow } from './audit.repo';

function toEvent(row: AuditRow) {
  return {
    id: row.id,
    actorEmail: row.actor_email,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export interface AuditEntry {
  workspaceId: string;
  actorUserId: string | null;
  action: AuditAction;
  resourceType: AuditResource;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export function createAuditService(deps: { pool: Pool; readPool?: Pool; clock: Clock; logger: Logger }) {
  const { pool, clock, logger } = deps;
  // Reading the trail tolerates replication lag; writing it never goes to a replica.
  const readPool = deps.readPool ?? pool;

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
      if (tx) await auditRepo.insertChained(tx, toRow(entry));
      else await withTransaction(pool, (own) => auditRepo.insertChained(own, toRow(entry)));
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
      void withTransaction(pool, (tx) => auditRepo.insertChained(tx, toRow(entry))).catch((error: unknown) => {
        logger.warn({ err: error, action: entry.action }, 'failed to write audit event');
      });
    },

    /**
     * Recomputes a workspace's hash chain from the start. Any event that was changed, inserted
     * or removed in the middle breaks the chain at that point. Removing events from the very end
     * leaves a shorter valid chain, so the head hash is returned: record it elsewhere (a log, a
     * ticket) and a later verify proves nothing after it was lost.
     */
    async verifyChain(workspaceId: string) {
      let previous: Buffer | null = null;
      let afterSeq = '0';
      let legacyEvents = 0;
      let chainedEvents = 0;
      let head: { eventId: string; hash: string; at: Date } | null = null;
      for (;;) {
        const page = await auditRepo.chainPage(readPool, workspaceId, afterSeq, 1000);
        if (page.length === 0) break;
        for (const row of page) {
          afterSeq = row.seq;
          if (!row.hash) {
            // Events from before hashing began are unverifiable, but may only come first.
            if (chainedEvents > 0)
              return {
                valid: false,
                legacyEvents,
                chainedEvents,
                head,
                brokenAt: { eventId: row.id, reason: 'event without a hash after the chain began' },
              };
            legacyEvents += 1;
            continue;
          }
          const followsPrevious = previous === null ? row.prev_hash === null : row.prev_hash?.equals(previous) === true;
          if (!followsPrevious) {
            return {
              valid: false,
              legacyEvents,
              chainedEvents,
              head,
              brokenAt: {
                eventId: row.id,
                reason: 'does not follow the previous event (an event was removed or inserted)',
              },
            };
          }
          const recomputed = chainHash(previous, {
            id: row.id,
            workspaceId: row.workspace_id,
            actorUserId: row.actor_user_id,
            action: row.action,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            metadata: row.metadata,
            createdAt: row.created_at,
          });
          if (!recomputed.equals(row.hash)) {
            return {
              valid: false,
              legacyEvents,
              chainedEvents,
              head,
              brokenAt: { eventId: row.id, reason: 'content does not match its hash (the event was changed)' },
            };
          }
          previous = row.hash;
          chainedEvents += 1;
          head = { eventId: row.id, hash: row.hash.toString('hex'), at: row.created_at };
        }
      }
      return { valid: true, legacyEvents, chainedEvents, head, brokenAt: null };
    },

    /** One page of the trail, newest first, and the cursor for the next (null at the end). */
    async list(
      workspaceId: string,
      userId: string,
      options: AuditFilter & { limit?: number; cursor?: string; before?: Date } = {},
    ) {
      const limit = Math.min(options.limit ?? 50, 200);
      const rows = await withTenant(readPool, userId, (db) =>
        auditRepo.listForWorkspace(db, workspaceId, { ...options, limit, afterSeq: options.cursor }),
      );
      return {
        events: rows.map(toEvent),
        nextCursor: rows.length === limit ? rows[rows.length - 1]!.seq : null,
      };
    },

    /** Every matching event, newest first, a batch at a time: for exports of any size. */
    async *exportRows(workspaceId: string, userId: string, filter: AuditFilter): AsyncGenerator<AuditRow> {
      let afterSeq: string | undefined;
      for (;;) {
        const rows = await withTenant(readPool, userId, (db) =>
          auditRepo.listForWorkspace(db, workspaceId, { ...filter, limit: 1000, afterSeq }),
        );
        yield* rows;
        if (rows.length < 1000) return;
        afterSeq = rows[rows.length - 1]!.seq;
      }
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
