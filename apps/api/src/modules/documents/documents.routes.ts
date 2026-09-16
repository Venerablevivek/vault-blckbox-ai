import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import { Errors } from '../../lib/errors';
import { currentUser, requireSession } from '../../plugins/session';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { SharesService } from '../shares/shares.service';
import type { DocumentsService } from './documents.service';
import type { DocumentListRow, DocumentRow } from './documents.repo';

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const documentParams = z.object({ id: z.string().uuid() });

function toDocumentDto(
  row: DocumentRow & {
    uploaded_by_email?: string;
    link_count?: string;
    opens?: string;
    last_accessed_at?: Date | null;
  },
) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size),
    uploadedBy: row.uploaded_by,
    uploadedByEmail: row.uploaded_by_email,
    createdAt: row.created_at,
    ...(row.link_count !== undefined
      ? {
          links: {
            count: Number(row.link_count),
            opens: Number(row.opens ?? 0),
            lastAccessedAt: row.last_accessed_at ?? null,
          },
        }
      : {}),
  };
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    documents: DocumentsService;
    workspaces: WorkspacesService;
    shares: SharesService;
  },
): void {
  const { config, documents, workspaces, shares } = deps;

  app.post('/api/workspaces/:workspaceId/documents', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(workspaceId, user.id);

      // The limit is applied by the multipart parser, so an oversize body is cut off
      // mid-stream rather than read into memory in full and rejected afterwards.
      const part = await request.file({ limits: { fileSize: config.MAX_UPLOAD_BYTES } });
      if (!part) {
        throw Errors.badRequest('NO_FILE', 'Expected a multipart form field named "file".');
      }

      const body = await part.toBuffer();

      const document = await documents.upload({
        membership,
        userId: user.id,
        userEmail: user.email,
        filename: part.filename,
        declaredMimeType: part.mimetype,
        body,
        truncated: part.file.truncated,
      });

      return reply.status(201).send({ document: toDocumentDto(document) });
    },
  });

  app.get('/api/workspaces/:workspaceId/documents', {
    preHandler: requireSession,
    handler: async (request) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(workspaceId, user.id);

      const rows: DocumentListRow[] = await documents.list(workspaceId);
      return {
        role: membership.role,
        documents: rows.map(toDocumentDto),
      };
    },
  });

  app.get('/api/documents/:id/download', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = documentParams.parse(request.params);
      const user = currentUser(request);
      const url = await documents.getDownloadUrl(id, user.id);
      // 302 to a 60-second signed URL. The object key never appears in a response body,
      // and the URL stops working almost immediately if it is copied elsewhere.
      return reply.redirect(url, 302);
    },
  });

  app.patch('/api/documents/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = documentParams.parse(request.params);
      const user = currentUser(request);
      const { filename } = z.object({ filename: z.string().min(1).max(255) }).parse(request.body);
      const document = await documents.rename(id, user.id, filename);
      return { document: toDocumentDto(document) };
    },
  });

  app.get('/api/documents/:id/preview', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = documentParams.parse(request.params);
      const user = currentUser(request);
      return reply.redirect(await documents.getPreviewUrl(id, user.id), 302);
    },
  });

  app.delete('/api/documents/:id', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = documentParams.parse(request.params);
      const user = currentUser(request);
      await documents.remove(id, user.id);
      return reply.status(204).send();
    },
  });

  // Lists the live share links for a document, so the UI can show and revoke them.
  // Tokens are never returned — only the row metadata.
  app.get('/api/documents/:id/shares', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = documentParams.parse(request.params);
      const user = currentUser(request);
      await documents.authorizeById(id, user.id);

      const rows = await shares.listForDocument(id);
      return {
        shares: rows.map(({ share, activity }) => ({
          id: share.id,
          createdBy: share.created_by,
          createdAt: share.created_at,
          expiresAt: share.expires_at,
          activity: {
            opens: activity.opens,
            downloads: activity.downloads,
            // Labelled an estimate in the UI: NAT merges viewers, network hopping splits them.
            distinctViewers: activity.distinctViewers,
            firstAccessedAt: activity.firstAccessedAt,
            lastAccessedAt: activity.lastAccessedAt,
            blockedAttempts: activity.blockedAttempts,
          },
        })),
      };
    },
  });
}
