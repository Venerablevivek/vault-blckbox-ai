import { obj, timestamp, uuid, z } from './common';

export const AuditAction = z
  .enum([
    'workspace.created',
    'workspace.renamed',
    'document.uploaded',
    'document.downloaded',
    'document.previewed',
    'document.deleted',
    'document.renamed',
    'document.moved',
    'document.trashed',
    'document.restored',
    'document.purged',
    'folder.created',
    'folder.renamed',
    'folder.moved',
    'folder.deleted',
    'share.created',
    'share.updated',
    'share.revoked',
    'share.accessed',
    'share.blocked',
    'member.invited',
    'member.joined',
    'member.removed',
    'member.left',
    'member.role_changed',
    'invitation.revoked',
    'document.quarantined',
  ])
  .openapi('AuditAction');

export const AuditEvent = obj({
  id: uuid,
  actorEmail: z.string().nullable(),
  action: AuditAction,
  resourceType: z.enum(['workspace', 'document', 'folder', 'share', 'member', 'invitation']),
  resourceId: uuid.nullable(),
  metadata: z.record(z.unknown()),
  createdAt: timestamp,
}).openapi('AuditEvent');

export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional().openapi({ type: 'string', format: 'date-time' }),
});
export const AuditResponse = obj({ events: z.array(AuditEvent) });
export const AuditVerifyResponse = obj({
  valid: z.boolean(),
  legacyEvents: z.number().int().openapi({ description: 'Events recorded before hashing began; not verifiable.' }),
  chainedEvents: z.number().int(),
  head: obj({ eventId: uuid, hash: z.string().regex(/^[0-9a-f]{64}$/), at: timestamp })
    .nullable()
    .openapi({
      description: 'The last verified event. Record its hash elsewhere to detect later removal from the end.',
    }),
  brokenAt: obj({ eventId: uuid, reason: z.string() }).nullable(),
}).openapi('AuditVerification');

export const NotificationType = z
  .enum([
    'share.first_open',
    'share.new_viewer',
    'share.forwarding_suspected',
    'document.uploaded',
    'member.joined',
    'member.removed',
    'member.role_changed',
    'workspace.deleted',
    'document.quarantined',
  ])
  .openapi('NotificationType');

export const Notification = obj({
  id: uuid,
  type: NotificationType,
  title: z.string(),
  body: z.string().nullable(),
  workspaceId: uuid.nullable(),
  resourceId: uuid.nullable(),
  read: z.boolean(),
  createdAt: timestamp,
}).openapi('Notification');

export const NotificationsResponse = obj({
  unread: z.number().int().nonnegative(),
  notifications: z.array(Notification),
});
export const MarkReadBody = z.object({ id: uuid.optional() }).openapi('MarkReadRequest');
