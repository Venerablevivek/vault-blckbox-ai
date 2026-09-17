import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import { Errors } from '../../lib/errors';
import { createSlots } from '../../lib/slots';
import { currentUser, requireSession } from '../../plugins/session';
import { toFolderDto } from '../folders/folders.service';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { SharesService } from '../shares/shares.service';
import type { DocumentsService } from './documents.service';
import type { DocumentListRow, DocumentRow } from './documents.repo';

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const documentParams = z.object({ id: z.string().uuid() });

function toDocumentDto(row: DocumentRow & Partial<DocumentListRow>) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256 ? row.sha256.toString('hex') : null,
    folderId: row.folder_id,
    uploadedBy: row.uploaded_by,
    uploadedByEmail: row.uploaded_by_email,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    deletedByEmail: row.deleted_by_email ?? null,
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

const listQuery = z.object({
  view: z.enum(['active', 'trash']).default('active'),
  folderId: z.string().uuid().optional(),
  q: z
    .string()
    .max(100)
    .transform((s) => s.trim())
    .optional(),
  filter: z.enum(['all', 'shared', 'mine']).default('all'),
  sort: z.enum(['date', 'name', 'size']).default('date'),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

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

  // At most MAX_CONCURRENT_UPLOADS files are buffered in this process at once, so worst-case
  // upload memory is MAX_CONCURRENT_UPLOADS x MAX_UPLOAD_BYTES rather than unbounded.
  const uploadSlots = createSlots(config.MAX_CONCURRENT_UPLOADS);

  app.post('/api/workspaces/:workspaceId/documents', {
    preHandler: requireSession,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const { folderId } = z.object({ folderId: z.string().uuid().optional() }).parse(request.query);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(workspaceId, user.id);

      // Take a slot before reading any of the body.
      const release = uploadSlots.tryAcquire();
      if (!release) {
        throw Errors.busy('UPLOADS_BUSY', 'The server is handling other uploads. Please retry in a moment.', 5);
      }

      try {
        // The multipart parser stops reading at the limit and marks the part truncated.
        const part = await request.file({ limits: { fileSize: config.MAX_UPLOAD_BYTES } });
        if (!part) throw Errors.badRequest('NO_FILE', 'Expected a multipart form field named "file".');
        const body = await part.toBuffer();

        const { document, duplicateOf } = await documents.upload({
          membership,
          userId: user.id,
          userEmail: user.email,
          folderId: folderId ?? null,
          filename: part.filename,
          declaredMimeType: part.mimetype,
          body,
          truncated: part.file.truncated,
        });
        return reply.status(201).send({ document: toDocumentDto(document), duplicateOf });
      } finally {
        release();
      }
    },
  });

  /**
   * Lists documents: server-side search, filter, sort and keyset pagination.
   *
   * With `q`, the whole workspace is searched regardless of folder. `view=trash` lists the
   * trash. The first page of a folder also returns its subfolders and breadcrumb path.
   */
  app.get('/api/workspaces/:workspaceId/documents', {
    preHandler: requireSession,
    handler: async (request) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(workspaceId, user.id);
      const query = listQuery.parse(request.query);

      const [result, storage] = await Promise.all([documents.list({
        membership,
        userId: user.id,
        view: query.view,
        folderId: query.folderId ?? null,
        search: query.q ? query.q : null,
        filter: query.filter,
        sort: query.sort,
        ascending: query.order ? query.order === 'asc' : query.sort === 'name',
        limit: query.limit,
        cursor: query.cursor ?? null,
      }), documents.storageUsage(workspaceId)]);

      return {
        role: membership.role,
        documents: result.documents.map(toDocumentDto),
        nextCursor: result.nextCursor,
        folders: result.folders.map(toFolderDto),
        path: result.path.map(toFolderDto),
        counts: result.counts,
        storage,
        // So the trash view can say when each document will be purged.
        trashRetentionDays: config.TRASH_RETENTION_DAYS,
      };
    },
  });

  app.get('/api/documents/:id/download', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = documentParams.parse(request.params);
      return reply.redirect(await documents.getDownloadUrl(id, currentUser(request).id), 302);
    },
  });

  app.get('/api/documents/:id/preview', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = documentParams.parse(request.params);
      return reply.redirect(await documents.getPreviewUrl(id, currentUser(request).id), 302);
    },
  });

  // Rename and/or move to another folder (folderId: null = workspace root).
  app.patch('/api/documents/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = documentParams.parse(request.params);
      const user = currentUser(request);
      const changes = z
        .object({
          filename: z.string().min(1).max(255).optional(),
          folderId: z.string().uuid().nullable().optional(),
        })
        .refine((c) => c.filename !== undefined || c.folderId !== undefined, 'Nothing to change.')
        .parse(request.body);
      const document = await documents.update(id, user.id, changes);
      return { document: toDocumentDto(document) };
    },
  });

  // Move to trash. Revokes the document's share links; restorable for TRASH_RETENTION_DAYS.
  app.delete('/api/documents/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = documentParams.parse(request.params);
      return documents.trash(id, currentUser(request).id);
    },
  });

  app.post('/api/documents/:id/restore', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = documentParams.parse(request.params);
      const document = await documents.restore(id, currentUser(request).id);
      return { document: toDocumentDto(document) };
    },
  });

  // Permanent delete of a trashed document. Owner only.
  app.delete('/api/documents/:id/permanent', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = documentParams.parse(request.params);
      await documents.purge(id, currentUser(request).id);
      return reply.status(204).send();
    },
  });

  // The live share links for a document. Tokens are never returned, only settings and activity.
  app.get('/api/documents/:id/shares', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = documentParams.parse(request.params);
      await documents.authorizeById(id, currentUser(request).id);
      const rows = await shares.listForDocument(id);
      return {
        shares: rows.map(({ share, activity }) => ({
          id: share.id,
          createdBy: share.created_by,
          createdAt: share.created_at,
          expiresAt: share.expires_at,
          hasPassword: share.password_hash !== null,
          maxDownloads: share.max_downloads,
          downloadCount: share.download_count,
          activity,
        })),
      };
    },
  });
}
