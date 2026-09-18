import { createHash } from 'node:crypto';

/** The fields an audit hash covers, exactly as stored. */
export interface ChainedFields {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/**
 * JSON with object keys sorted at every level. PostgreSQL's jsonb reorders keys, so the metadata
 * read back is not in the order it was written; hashing the canonical form makes both agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256(previous hash, or 32 zero bytes for the first event, || canonical event). */
export function chainHash(previous: Buffer | null, event: ChainedFields): Buffer {
  return createHash('sha256')
    .update(previous ?? Buffer.alloc(32))
    .update(
      canonicalJson({
        id: event.id,
        workspaceId: event.workspaceId,
        actorUserId: event.actorUserId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      }),
    )
    .digest();
}
