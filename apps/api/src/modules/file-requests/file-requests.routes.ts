import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config';
import {
  CreateFileRequestBody,
  FileRequestParams,
  FileRequestTokenParams,
  FileRequestWorkspaceParams,
  SenderFields,
} from '../../contracts/file-requests';
import { Errors } from '../../lib/errors';
import { createSlots } from '../../lib/slots';
import { Permissions } from '../../policy';
import { currentUser, requireSession } from '../../plugins/session';
import type { Role } from '../../types';
import type { FileRequestRow } from './file-requests.repo';
import { fileRequestStatus, type FileRequestsService } from './file-requests.service';

/** The value of a plain multipart field that came before the file, if any. */
function fieldValue(fields: Record<string, unknown>, name: string): string | null {
  const field: unknown = fields[name];
  const first: unknown = Array.isArray(field) ? (field as unknown[])[0] : field;
  if (typeof first !== 'object' || first === null || !('value' in first)) return null;
  const { value } = first;
  return typeof value === 'string' ? value : null;
}

export function registerFileRequestRoutes(
  app: FastifyInstance,
  deps: { config: Config; fileRequests: FileRequestsService; now: () => Date },
): void {
  const { config, fileRequests } = deps;
  // Public uploads get their own slots, so outsiders can never crowd out members' uploads.
  const publicSlots = createSlots(Math.max(1, Math.floor(config.MAX_CONCURRENT_UPLOADS / 2)));

  const toDto = (row: FileRequestRow, userId: string, role: Role) => ({
    id: row.id,
    title: row.title,
    message: row.message,
    folderId: row.folder_id,
    folderName: row.folder_name,
    createdBy: row.created_by,
    createdByEmail: row.creator_email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    maxFiles: row.max_files,
    receivedCount: row.received_count,
    lastReceivedAt: row.last_received_at,
    status: fileRequestStatus(row, deps.now()),
    canManage: Permissions.canManageShare(role, row.created_by, userId),
  });

  app.post('/api/workspaces/:workspaceId/file-requests', {
    preHandler: requireSession,
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    handler: async (request, reply) => {
      const { workspaceId } = FileRequestWorkspaceParams.parse(request.params);
      const body = CreateFileRequestBody.parse(request.body);
      const userId = currentUser(request).id;
      const created = await fileRequests.create(userId, workspaceId, body);
      return reply.status(201).send({ request: toDto(created.request, userId, created.role), url: created.url });
    },
  });

  app.get('/api/workspaces/:workspaceId/file-requests', { preHandler: requireSession }, async (request) => {
    const { workspaceId } = FileRequestWorkspaceParams.parse(request.params);
    const userId = currentUser(request).id;
    const { requests, role } = await fileRequests.list(userId, workspaceId);
    return { requests: requests.map((r) => toDto(r, userId, role)) };
  });

  app.get('/api/file-requests/:id/files', { preHandler: requireSession }, async (request) => {
    const { id } = FileRequestParams.parse(request.params);
    const files = await fileRequests.received(id, currentUser(request).id);
    return {
      files: files.map((f) => ({
        id: f.id,
        documentId: f.document_id,
        senderName: f.sender_name,
        senderEmail: f.sender_email,
        filename: f.filename,
        size: Number(f.size),
        receivedAt: f.created_at,
      })),
    };
  });

  app.delete('/api/file-requests/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = FileRequestParams.parse(request.params);
    await fileRequests.revoke(id, currentUser(request).id);
    return reply.status(204).send();
  });

  // Public: whoever holds the link.
  app.get(
    '/api/requests/:token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token } = FileRequestTokenParams.parse(request.params);
      void reply.header('Cache-Control', 'no-store');
      return { request: await fileRequests.publicInfo(token) };
    },
  );

  app.post('/api/requests/:token/files', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const { token } = FileRequestTokenParams.parse(request.params);
      const release = publicSlots.tryAcquire();
      if (!release) {
        throw Errors.busy('UPLOADS_BUSY', 'The server is handling other uploads. Please retry in a moment.', 5);
      }
      try {
        const part = await request.file({ limits: { fileSize: config.MAX_UPLOAD_BYTES } });
        if (!part) throw Errors.badRequest('NO_FILE', 'Expected a multipart form field named "file".');
        // name and email are sent as fields before the file, so they are parsed by now.
        const fields = part.fields as Record<string, unknown>;
        const sender = SenderFields.parse({
          name: fieldValue(fields, 'name') ?? '',
          email: fieldValue(fields, 'email'),
        });
        const body = await part.toBuffer();
        const result = await fileRequests.publicUpload(token, {
          senderName: sender.name,
          senderEmail: sender.email ?? null,
          filename: part.filename,
          declaredMimeType: part.mimetype,
          body,
          truncated: part.file.truncated,
        });
        return reply.status(201).send(result);
      } finally {
        release();
      }
    },
  });
}
