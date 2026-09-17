import { obj, Role, StorageUsage, timestamp, uuid, z } from './common';
import { AuditEvent } from './activity';

export const WorkspaceParams = obj({ id: uuid });
export const MemberParams = obj({ id: uuid, userId: uuid });
export const InvitationParams = obj({ id: uuid, invitationId: uuid });
export const InviteTokenParams = obj({ token: z.string().min(10).max(200) });

const workspaceName = z.string().trim().min(1).max(120);
export const CreateWorkspaceBody = z.object({ name: workspaceName }).openapi('CreateWorkspaceRequest');
export const RenameWorkspaceBody = z.object({ name: workspaceName }).openapi('RenameWorkspaceRequest');
export const DeleteWorkspaceBody = z
  .object({ confirmName: z.string().max(200).openapi({ description: "The workspace's exact current name." }) })
  .openapi('DeleteWorkspaceRequest');
export const ChangeRoleBody = z.object({ role: Role }).openapi('ChangeRoleRequest');
export const InviteBody = z
  .object({ email: z.string().email().max(255), role: Role.default('MEMBER') })
  .openapi('InviteRequest');
export const OverviewQuery = z.object({
  tz: z.string().max(64).optional().openapi({
    description: 'IANA time zone for daily series; unknown zones fall back to UTC.',
    example: 'Europe/London',
  }),
});

export const WorkspaceResponse = obj({ workspace: obj({ id: uuid, name: z.string(), role: Role }) });
export const RenamedWorkspaceResponse = obj({ workspace: obj({ id: uuid, name: z.string() }) });
export const WorkspacesResponse = obj({ workspaces: z.array(obj({ id: uuid, name: z.string(), role: Role })) });
export const StorageResponse = obj({ storage: StorageUsage });

export const Member = obj({ userId: uuid, email: z.string(), role: Role, joinedAt: timestamp }).openapi('Member');
export const PendingInvitation = obj({ id: uuid, email: z.string(), role: Role, expiresAt: timestamp }).openapi(
  'PendingInvitation',
);
export const MembersResponse = obj({
  role: Role,
  members: z.array(Member),
  invitations: z.array(PendingInvitation).openapi({ description: 'Pending invitations; always empty for non-owners.' }),
});

export const InvitationCreatedResponse = obj({
  invitation: PendingInvitation,
  inviteUrl: z
    .string()
    .url()
    .optional()
    .openapi({ description: 'Only when EXPOSE_INVITE_LINKS is enabled (development).' }),
  emailSent: z.boolean(),
});
export const InvitationPreviewResponse = obj({
  workspaceName: z.string(),
  email: z.string(),
  role: Role,
  expiresAt: timestamp,
}).openapi('InvitationPreview');
export const InvitationAcceptedResponse = obj({ workspaceId: uuid, workspaceName: z.string() });

export const OverviewResponse = obj({
  role: Role,
  totals: obj({
    documents: z.number().int(),
    bytes: z.number().int(),
    members: z.number().int(),
    liveLinks: z.number().int(),
    opens: z.number().int(),
    pendingInvites: z.number().int(),
  }),
  storage: StorageUsage,
  storageByType: z.array(obj({ category: z.string(), count: z.number().int(), bytes: z.number().int() })),
  series: z.array(
    obj({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), uploads: z.number().int(), opens: z.number().int() }),
  ),
  topShared: z.array(
    obj({
      id: uuid,
      filename: z.string(),
      mimeType: z.string(),
      opens: z.number().int(),
      viewers: z.number().int(),
      lastAccessedAt: timestamp.nullable(),
    }),
  ),
  recentDocuments: z.array(
    obj({
      id: uuid,
      filename: z.string(),
      mimeType: z.string(),
      size: z.number().int(),
      createdAt: timestamp,
      uploadedByEmail: z.string(),
    }),
  ),
  recentActivity: z.array(AuditEvent).nullable().openapi({ description: 'null for non-owners.' }),
}).openapi('Overview');
