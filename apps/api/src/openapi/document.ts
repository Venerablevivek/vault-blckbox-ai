import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import * as auth from '../contracts/auth';
import * as activity from '../contracts/activity';
import { ErrorBody, z } from '../contracts/common';
import * as documents from '../contracts/documents';
import * as shares from '../contracts/shares';
import * as uploads from '../contracts/uploads';
import * as workspaces from '../contracts/workspaces';

type Method = RouteConfig['method'];
type ZodSchema = z.ZodTypeAny;

const json = (schema: ZodSchema) => ({ content: { 'application/json': { schema } } });

const errors = {
  400: { description: 'Invalid request (`VALIDATION_FAILED` with details, or a specific code).', ...json(ErrorBody) },
  401: { description: 'Not signed in.', ...json(ErrorBody) },
  403: { description: 'Signed in and a member, but the role does not allow this.', ...json(ErrorBody) },
  404: { description: 'Not found, or not a member (deliberately identical).', ...json(ErrorBody) },
  409: { description: 'Conflict with the current state.', ...json(ErrorBody) },
  410: { description: 'Gone: revoked, expired, used up, or already used.', ...json(ErrorBody) },
  413: { description: 'File too large, or the workspace quota is full (`QUOTA_EXCEEDED`).', ...json(ErrorBody) },
  415: { description: 'File type not allowed.', ...json(ErrorBody) },
  422: { description: 'Well-formed but not allowed (e.g. moving a folder into itself).', ...json(ErrorBody) },
  429: { description: 'Rate limited or locked out. See Retry-After.', ...json(ErrorBody) },
  503: { description: 'At capacity; retry after Retry-After seconds.', ...json(ErrorBody) },
} as const;
type ErrorStatus = keyof typeof errors;

interface Operation {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  description?: string;
  auth?: 'session' | 'public';
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: ZodSchema;
  multipart?: boolean;
  /** Success status and body; null body means no content. */
  success: [number, ZodSchema | null] | 'redirect' | 'stream' | { file: string };
  errors?: ErrorStatus[];
}

/** Express-style `:param` paths become OpenAPI `{param}` paths. */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

const S = 'session' as const;
const P = 'public' as const;

/**
 * Every API route. `tests/contract/openapi.test.ts` fails if a route exists in the server but
 * not here (or the reverse), and checks real responses against the success schemas.
 */
export const operations: Operation[] = [
  // ---- Auth -------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/auth/register',
    tag: 'Auth',
    summary: 'Create an account and its first workspace',
    auth: P,
    body: auth.RegisterBody,
    success: [201, auth.UserResponse],
    errors: [400, 409, 429],
    description: 'Sets the session cookie. With inviteToken, joins that workspace in the same transaction.',
  },
  {
    method: 'post',
    path: '/api/auth/login',
    tag: 'Auth',
    summary: 'Sign in',
    auth: P,
    body: auth.CredentialsBody,
    success: [200, auth.UserResponse],
    errors: [400, 401, 429],
    description:
      'Sets the session cookie. Five failures in 15 minutes lock the address from anywhere (ACCOUNT_LOCKED).',
  },
  { method: 'post', path: '/api/auth/logout', tag: 'Auth', summary: 'Sign out', auth: P, success: [204, null] },
  {
    method: 'get',
    path: '/api/auth/me',
    tag: 'Auth',
    summary: 'Current user and their workspaces',
    auth: S,
    success: [200, auth.MeResponse],
    errors: [401],
  },
  {
    method: 'post',
    path: '/api/auth/password/forgot',
    tag: 'Auth',
    summary: 'Email a password reset link',
    auth: P,
    body: auth.ForgotPasswordBody,
    success: [202, auth.MessageResponse],
    errors: [400, 429],
    description: 'Always 202 with the same body, whether or not the address has an account.',
  },
  {
    method: 'post',
    path: '/api/auth/password/reset',
    tag: 'Auth',
    summary: 'Set a new password with a reset token',
    auth: P,
    body: auth.ResetPasswordBody,
    success: [200, auth.ResetPasswordResponse],
    errors: [400, 410, 429],
    description: 'Ends every session, then signs this browser in.',
  },
  {
    method: 'post',
    path: '/api/auth/password',
    tag: 'Auth',
    summary: 'Change password',
    auth: S,
    body: auth.ChangePasswordBody,
    success: [200, auth.SignedOutResponse],
    errors: [400, 401, 429],
    description: 'Requires the current password. Ends every other session.',
  },
  {
    method: 'post',
    path: '/api/auth/email/verify',
    tag: 'Auth',
    summary: 'Confirm an email address',
    auth: P,
    body: auth.VerifyEmailBody,
    success: [204, null],
    errors: [400, 410, 429],
    description: 'The token comes from the emailed link (in its URL fragment).',
  },
  {
    method: 'post',
    path: '/api/auth/email/resend',
    tag: 'Auth',
    summary: 'Send another confirmation email',
    auth: S,
    success: [202, auth.MessageResponse],
    errors: [401, 409, 429],
  },
  {
    method: 'get',
    path: '/api/auth/sessions',
    tag: 'Auth',
    summary: 'List your sessions',
    auth: S,
    success: [200, auth.SessionsResponse],
    errors: [401],
  },
  {
    method: 'delete',
    path: '/api/auth/sessions',
    tag: 'Auth',
    summary: 'Sign out every other session',
    auth: S,
    success: [200, auth.SignedOutResponse],
    errors: [401],
  },
  {
    method: 'delete',
    path: '/api/auth/sessions/:sessionId',
    tag: 'Auth',
    summary: 'Sign out one session',
    auth: S,
    params: auth.SessionParams,
    success: [204, null],
    errors: [401, 404],
  },

  // ---- Workspaces -------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/workspaces',
    tag: 'Workspaces',
    summary: 'List your workspaces',
    auth: S,
    success: [200, workspaces.WorkspacesResponse],
    errors: [401],
  },
  {
    method: 'post',
    path: '/api/workspaces',
    tag: 'Workspaces',
    summary: 'Create a workspace',
    auth: S,
    body: workspaces.CreateWorkspaceBody,
    success: [201, workspaces.WorkspaceResponse],
    errors: [400, 401],
  },
  {
    method: 'patch',
    path: '/api/workspaces/:id',
    tag: 'Workspaces',
    summary: 'Rename a workspace',
    auth: S,
    params: workspaces.WorkspaceParams,
    body: workspaces.RenameWorkspaceBody,
    success: [200, workspaces.RenamedWorkspaceResponse],
    errors: [400, 401, 403, 404],
  },
  {
    method: 'delete',
    path: '/api/workspaces/:id',
    tag: 'Workspaces',
    summary: 'Delete a workspace',
    auth: S,
    params: workspaces.WorkspaceParams,
    body: workspaces.DeleteWorkspaceBody,
    success: [204, null],
    errors: [400, 401, 403, 404],
    description: 'Owner only. Access ends immediately; files are removed by the next maintenance pass.',
  },
  {
    method: 'get',
    path: '/api/workspaces/:id/overview',
    tag: 'Workspaces',
    summary: 'Dashboard data',
    auth: S,
    params: workspaces.WorkspaceParams,
    query: workspaces.OverviewQuery,
    success: [200, workspaces.OverviewResponse],
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/api/workspaces/:id/storage',
    tag: 'Workspaces',
    summary: 'Storage used and quota',
    auth: S,
    params: workspaces.WorkspaceParams,
    success: [200, workspaces.StorageResponse],
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/api/workspaces/:id/members',
    tag: 'Members',
    summary: 'Members, and pending invitations for owners',
    auth: S,
    params: workspaces.WorkspaceParams,
    success: [200, workspaces.MembersResponse],
    errors: [401, 404],
  },
  {
    method: 'patch',
    path: '/api/workspaces/:id/members/:userId',
    tag: 'Members',
    summary: "Change a member's role",
    auth: S,
    params: workspaces.MemberParams,
    body: workspaces.ChangeRoleBody,
    success: [204, null],
    errors: [400, 401, 403, 404, 409],
    description: 'Demoting to VIEWER revokes their share links. The last owner cannot be demoted.',
  },
  {
    method: 'delete',
    path: '/api/workspaces/:id/members/:userId',
    tag: 'Members',
    summary: 'Remove a member, or leave',
    auth: S,
    params: workspaces.MemberParams,
    success: [204, null],
    errors: [401, 403, 404, 409],
  },
  {
    method: 'post',
    path: '/api/workspaces/:id/invitations',
    tag: 'Members',
    summary: 'Invite by email',
    auth: S,
    params: workspaces.WorkspaceParams,
    body: workspaces.InviteBody,
    success: [201, workspaces.InvitationCreatedResponse],
    errors: [400, 401, 403, 404, 409, 429],
  },
  {
    method: 'delete',
    path: '/api/workspaces/:id/invitations/:invitationId',
    tag: 'Members',
    summary: 'Cancel an invitation',
    auth: S,
    params: workspaces.InvitationParams,
    success: [204, null],
    errors: [401, 403, 404],
  },
  {
    method: 'get',
    path: '/api/invitations/:token',
    tag: 'Members',
    summary: 'Preview an invitation',
    auth: P,
    params: workspaces.InviteTokenParams,
    success: [200, workspaces.InvitationPreviewResponse],
    errors: [404, 410, 429],
  },
  {
    method: 'post',
    path: '/api/invitations/:token/accept',
    tag: 'Members',
    summary: 'Accept an invitation',
    auth: S,
    params: workspaces.InviteTokenParams,
    success: [200, workspaces.InvitationAcceptedResponse],
    errors: [401, 404, 409, 410],
  },

  // ---- Documents --------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/workspaces/:workspaceId/documents',
    tag: 'Documents',
    summary: 'List, search and page documents',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    query: documents.ListDocumentsQuery,
    success: [200, documents.DocumentListResponse],
    errors: [400, 401, 404],
  },
  {
    method: 'post',
    path: '/api/workspaces/:workspaceId/documents',
    tag: 'Documents',
    summary: 'Upload a document',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    query: documents.UploadQuery,
    multipart: true,
    success: [201, documents.UploadResponse],
    errors: [400, 401, 403, 404, 413, 415, 429, 503],
  },
  {
    method: 'patch',
    path: '/api/documents/:id',
    tag: 'Documents',
    summary: 'Rename or move',
    auth: S,
    params: documents.DocumentParams,
    body: documents.UpdateDocumentBody,
    success: [200, documents.DocumentResponse],
    errors: [400, 401, 403, 404],
  },
  {
    method: 'delete',
    path: '/api/documents/:id',
    tag: 'Documents',
    summary: 'Move to trash',
    auth: S,
    params: documents.DocumentParams,
    success: [200, documents.TrashResponse],
    errors: [401, 403, 404],
    description: "Revokes the document's share links.",
  },
  {
    method: 'post',
    path: '/api/documents/bulk',
    tag: 'Documents',
    summary: 'Trash, restore, permanently delete or move many documents',
    description:
      'Each document is authorized and handled on its own, exactly as by its single-document endpoint, so some can fail while the rest succeed. Always 200; check each result.',
    auth: S,
    body: documents.BulkDocumentsBody,
    success: [200, documents.BulkDocumentsResponse],
    errors: [400, 401, 429],
  },
  {
    method: 'get',
    path: '/api/workspaces/:workspaceId/archive',
    tag: 'Documents',
    summary: 'Download documents or a folder as a zip',
    description:
      'Streams a zip built from storage. Folders keep their structure. Files the malware scan has not cleared are left out and listed in NOT-INCLUDED.txt inside the zip. Each included file is recorded as downloaded.',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    query: documents.ArchiveQuery,
    success: { file: 'application/zip' },
    errors: [400, 401, 404, 409, 413, 429, 503],
  },
  {
    method: 'get',
    path: '/api/workspaces/:workspaceId/archive/summary',
    tag: 'Documents',
    summary: 'What a zip download would contain, without building it',
    description: 'Same checks and errors as the download itself; nothing is read from storage or recorded.',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    query: documents.ArchiveQuery,
    success: [200, documents.ArchiveSummaryResponse],
    errors: [400, 401, 404, 409, 413],
  },
  {
    method: 'put',
    path: '/api/documents/:id/star',
    tag: 'Documents',
    summary: 'Star a document (for you only)',
    auth: S,
    params: documents.DocumentParams,
    success: [204, null],
    errors: [401, 404],
  },
  {
    method: 'delete',
    path: '/api/documents/:id/star',
    tag: 'Documents',
    summary: 'Unstar a document',
    auth: S,
    params: documents.DocumentParams,
    success: [204, null],
    errors: [401, 404],
  },
  {
    method: 'post',
    path: '/api/documents/:id/restore',
    tag: 'Documents',
    summary: 'Restore from trash',
    auth: S,
    params: documents.DocumentParams,
    success: [200, documents.DocumentResponse],
    errors: [401, 403, 404, 410],
  },
  {
    method: 'delete',
    path: '/api/documents/:id/permanent',
    tag: 'Documents',
    summary: 'Delete forever',
    auth: S,
    params: documents.DocumentParams,
    success: [204, null],
    errors: [401, 403, 404],
  },
  {
    method: 'get',
    path: '/api/documents/:id/download',
    tag: 'Documents',
    summary: 'Download (redirect to a 60-second signed URL)',
    auth: S,
    params: documents.DocumentParams,
    success: 'redirect',
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/api/documents/:id/preview',
    tag: 'Documents',
    summary: 'Inline preview (PDF and images)',
    auth: S,
    params: documents.DocumentParams,
    success: 'redirect',
    errors: [401, 404, 415],
  },
  {
    method: 'get',
    path: '/api/documents/:id/shares',
    tag: 'Sharing',
    summary: "A document's live links and their activity",
    auth: S,
    params: documents.DocumentParams,
    success: [200, shares.SharesResponse],
    errors: [401, 404],
  },

  // ---- Direct uploads ---------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/workspaces/:workspaceId/uploads',
    tag: 'Uploads',
    summary: 'Start a direct upload',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    body: uploads.CreateUploadBody,
    success: [201, uploads.UploadCreatedResponse],
    errors: [400, 401, 403, 404, 413, 415, 429],
    description:
      'Reserves quota for the whole file and opens a multipart upload in storage. The browser then PUTs each part to a signed URL; file bytes never pass through the API. Up to MAX_DIRECT_UPLOAD_BYTES (5 GB).',
  },
  {
    method: 'post',
    path: '/api/uploads/:id/parts',
    tag: 'Uploads',
    summary: 'Get signed URLs for parts',
    auth: S,
    params: uploads.UploadParams,
    body: uploads.SignPartsBody,
    success: [200, uploads.SignedPartsResponse],
    errors: [400, 401, 403, 404, 409, 429],
  },
  {
    method: 'get',
    path: '/api/uploads/:id',
    tag: 'Uploads',
    summary: 'Upload status and parts received (for resuming)',
    auth: S,
    params: uploads.UploadParams,
    success: [200, uploads.UploadStatusResponse],
    errors: [401, 403, 404],
  },
  {
    method: 'post',
    path: '/api/uploads/:id/complete',
    tag: 'Uploads',
    summary: 'Finish an upload and create the document',
    auth: S,
    params: uploads.UploadParams,
    success: [201, documents.UploadResponse],
    errors: [400, 401, 403, 404, 409, 415],
    description:
      "Verifies every part against storage's record, the assembled size, and the file type from its first bytes. A file that fails is deleted and its quota released; missing parts leave the upload open (409 UPLOAD_INCOMPLETE).",
  },
  {
    method: 'delete',
    path: '/api/uploads/:id',
    tag: 'Uploads',
    summary: 'Cancel an upload',
    auth: S,
    params: uploads.UploadParams,
    success: [204, null],
    errors: [401, 403, 404, 409],
  },

  // ---- Folders ----------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/workspaces/:workspaceId/folders',
    tag: 'Folders',
    summary: 'List folders',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    query: documents.ListFoldersQuery,
    success: [200, documents.FoldersResponse],
    errors: [401, 404],
  },
  {
    method: 'post',
    path: '/api/workspaces/:workspaceId/folders',
    tag: 'Folders',
    summary: 'Create a folder',
    auth: S,
    params: documents.WorkspaceDocumentsParams,
    body: documents.CreateFolderBody,
    success: [201, documents.FolderResponse],
    errors: [400, 401, 403, 404, 409, 422],
  },
  {
    method: 'patch',
    path: '/api/workspaces/:workspaceId/folders/:folderId',
    tag: 'Folders',
    summary: 'Rename or move a folder',
    auth: S,
    params: documents.FolderParams,
    body: documents.UpdateFolderBody,
    success: [200, documents.FolderResponse],
    errors: [400, 401, 403, 404, 409, 422],
  },
  {
    method: 'delete',
    path: '/api/workspaces/:workspaceId/folders/:folderId',
    tag: 'Folders',
    summary: 'Delete an empty folder',
    auth: S,
    params: documents.FolderParams,
    success: [204, null],
    errors: [401, 403, 404, 409],
  },

  // ---- Sharing ----------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/shares',
    tag: 'Sharing',
    summary: 'Create a share link',
    auth: S,
    body: shares.CreateShareBody,
    success: [201, shares.ShareCreatedResponse],
    errors: [400, 401, 403, 404],
  },
  {
    method: 'patch',
    path: '/api/shares/:id',
    tag: 'Sharing',
    summary: "Edit a link's expiry, password or download limit",
    auth: S,
    params: shares.ShareIdParams,
    body: shares.UpdateShareBody,
    success: [200, shares.ShareUpdatedResponse],
    errors: [400, 401, 403, 404, 409],
  },
  {
    method: 'delete',
    path: '/api/shares/:id',
    tag: 'Sharing',
    summary: 'Revoke a link',
    auth: S,
    params: shares.ShareIdParams,
    success: [204, null],
    errors: [401, 403, 404],
  },
  {
    method: 'get',
    path: '/api/shares/:id/events',
    tag: 'Sharing',
    summary: "A link's access history",
    auth: S,
    params: shares.ShareIdParams,
    success: [200, shares.ShareEventsResponse],
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/api/shares/:token',
    tag: 'Public sharing',
    summary: 'Resolve a link',
    auth: P,
    params: shares.ShareTokenParams,
    success: [200, shares.PublicShareResponse],
    errors: [404, 410, 429],
    description: 'Records nothing. A locked link reveals only that a password is required.',
  },
  {
    method: 'post',
    path: '/api/shares/:token/unlock',
    tag: 'Public sharing',
    summary: 'Enter a link password',
    auth: P,
    params: shares.ShareTokenParams,
    body: shares.UnlockBody,
    success: [204, null],
    errors: [400, 401, 404, 410, 429],
    description: 'Sets an HttpOnly cookie that unlocks this link for one hour.',
  },
  {
    method: 'post',
    path: '/api/shares/:token/view',
    tag: 'Public sharing',
    summary: 'Record a page view',
    auth: P,
    params: shares.ShareTokenParams,
    success: [204, null],
    errors: [401, 404, 410, 429],
  },
  {
    method: 'get',
    path: '/api/shares/:token/download',
    tag: 'Public sharing',
    summary: 'Download (redirect to a signed URL)',
    auth: P,
    params: shares.ShareTokenParams,
    success: 'redirect',
    errors: [401, 404, 410, 429],
  },

  // ---- Activity ---------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/workspaces/:id/audit',
    tag: 'Activity',
    summary: 'Audit trail (owners)',
    auth: S,
    params: workspaces.WorkspaceParams,
    query: activity.AuditQuery,
    success: [200, activity.AuditResponse],
    errors: [400, 401, 403, 404],
  },
  {
    method: 'get',
    path: '/api/workspaces/:id/audit/verify',
    tag: 'Activity',
    summary: 'Verify the audit hash chain (owners)',
    auth: S,
    params: workspaces.WorkspaceParams,
    success: [200, activity.AuditVerifyResponse],
    errors: [401, 403, 404, 429],
    description:
      'Recomputes every event hash in order. Reports where the chain breaks if an event was changed, inserted or removed. Removal from the end is only detectable against a previously recorded head hash.',
  },

  {
    method: 'get',
    path: '/api/notifications',
    tag: 'Activity',
    summary: 'Your notifications',
    auth: S,
    success: [200, activity.NotificationsResponse],
    errors: [401],
  },
  {
    method: 'get',
    path: '/api/openapi.json',
    tag: 'Operations',
    summary: 'This OpenAPI document',
    auth: P,
    success: [200, z.record(z.unknown())],
  },
  {
    method: 'get',
    path: '/api/notifications/stream',
    tag: 'Activity',
    summary: 'Live notification events (server-sent events)',
    auth: S,
    success: 'stream',
    errors: [401, 429],
    description:
      'text/event-stream. Sends `event: ready` on connect and `event: notification` whenever your inbox changes; fetch GET /api/notifications on either. A keep-alive comment is sent periodically, and the stream ends when the session does. At most 5 streams per user.',
  },
  {
    method: 'post',
    path: '/api/notifications/read',
    tag: 'Activity',
    summary: 'Mark one or all notifications read',
    auth: S,
    body: activity.MarkReadBody,
    success: [204, null],
    errors: [400, 401],
  },
];

/** Routes that exist for infrastructure, documented but outside /api. */
const operational: Operation[] = [
  {
    method: 'get',
    path: '/health',
    tag: 'Operations',
    summary: 'Liveness',
    auth: P,
    success: [200, z.object({ status: z.literal('ok') })],
  },
  {
    method: 'get',
    path: '/ready',
    tag: 'Operations',
    summary: 'Readiness (database reachable)',
    auth: P,
    success: [200, z.object({ status: z.literal('ready') })],
    errors: [503],
  },
];

export const allOperations = [...operations, ...operational];

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'fs_session',
    description: 'Session cookie set by /api/auth/login or /api/auth/register.',
  });

  for (const op of allOperations) {
    const responses: RouteConfig['responses'] = {};
    if (op.success === 'stream') {
      responses[200] = {
        description: 'An open stream of server-sent events.',
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      };
    } else if (typeof op.success === 'object' && !Array.isArray(op.success)) {
      responses[200] = {
        description: 'The file, streamed as an attachment.',
        content: { [op.success.file]: { schema: { type: 'string', format: 'binary' } } },
      };
    } else if (op.success === 'redirect') {
      responses[302] = {
        description: 'Redirect to a short-lived signed URL.',
        headers: { Location: { schema: { type: 'string', format: 'uri' } } },
      };
    } else {
      const [status, schema] = op.success;
      responses[status] = schema ? { description: 'Success', ...json(schema) } : { description: 'Success, no content' };
    }
    for (const code of op.errors ?? []) responses[code] = errors[code];

    registry.registerPath({
      method: op.method,
      path: toOpenApiPath(op.path),
      summary: op.summary,
      description: op.description,
      tags: [op.tag],
      security: op.auth === 'session' ? [{ session: [] }] : [],
      request: {
        ...(op.params ? { params: op.params } : {}),
        ...(op.query ? { query: op.query } : {}),
        ...(op.body ? { body: { required: true, ...json(op.body) } } : {}),
        ...(op.multipart
          ? {
              body: {
                required: true,
                content: {
                  'multipart/form-data': {
                    schema: z.object({ file: z.any().openapi({ type: 'string', format: 'binary' }) }),
                  },
                },
              },
            }
          : {}),
      },
      responses,
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Vault API',
      version: '1.0.0',
      description:
        'Document storage, workspaces and revocable share links. JSON over HTTPS with a session cookie. ' +
        'Every error has the shape { error: { code, message } }. The same routes are served under /api/v1.',
    },
    servers: [{ url: '/' }],
  });
}
