import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config';
import {
  ArchiveQuery,
  BulkDocumentsBody,
  DocumentParams,
  ListDocumentsQuery,
  UpdateDocumentBody,
  UploadQuery,
  WorkspaceDocumentsParams,
} from '../../contracts/documents';
import { Errors } from '../../lib/errors';
import { createSlots } from '../../lib/slots';
import { currentUser, requireSession } from '../../plugins/session';
import { toFolderDto } from '../folders/folders.service';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { SharesService } from '../shares/shares.service';
import type { DocumentsService } from './documents.service';
import type { FileStorage } from '../../storage/file-storage';
import { createArchiveStream } from './archive';
import type { DocumentListRow, DocumentRow } from './documents.repo';

export function toDocumentDto(row: DocumentRow & Partial<DocumentListRow>) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256 ? row.sha256.toString('hex') : null,
    scanStatus: row.scan_status,
    ...(row.starred !== undefined ? { starred: row.starred } : {}),
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

/**
 * Content-Disposition for a response: a plain-ASCII filename for old clients, and the real
 * one in RFC 5987 form for everything else.
 */
export function attachmentDisposition(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function archiveSelection(ids: string[] | undefined, folderId: string | undefined) {
  if (ids !== undefined && folderId === undefined) return { ids };
  if (folderId !== undefined && ids === undefined) return { folderId };
  throw Errors.badRequest('INVALID_SELECTION', 'Give either ids or folderId.');
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    documents: DocumentsService;
    workspaces: WorkspacesService;
    shares: SharesService;
    storage: FileStorage;
  },
): void {
  const { config, documents, workspaces, shares, storage } = deps;
  const archiveSlots = createSlots(config.MAX_CONCURRENT_ARCHIVES);

  // At most MAX_CONCURRENT_UPLOADS files are buffered in this process at once, so worst-case
  // upload memory is MAX_CONCURRENT_UPLOADS x MAX_UPLOAD_BYTES rather than unbounded.
  const uploadSlots = createSlots(config.MAX_CONCURRENT_UPLOADS);

  app.post('/api/workspaces/:workspaceId/documents', {
    preHandler: requireSession,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
      const { folderId } = UploadQuery.parse(request.query);
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
      const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(workspaceId, user.id);
      const query = ListDocumentsQuery.parse(request.query);

      const [result, storage] = await Promise.all([
        documents.list({
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
        }),
        documents.storageUsage(workspaceId),
      ]);

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
      const { id } = DocumentParams.parse(request.params);
      return reply.redirect(await documents.getDownloadUrl(id, currentUser(request).id), 302);
    },
  });

  app.get('/api/documents/:id/preview', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = DocumentParams.parse(request.params);
      return reply.redirect(await documents.getPreviewUrl(id, currentUser(request).id), 302);
    },
  });

  app.post('/api/documents/bulk', {
    preHandler: requireSession,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { action, ids, folderId } = BulkDocumentsBody.parse(request.body);
      const results = await documents.bulk(currentUser(request).id, action, ids, folderId ?? null);
      const succeeded = results.filter((r) => r.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    },
  });

  // What a zip download would contain, without building it: lets the app explain a refusal
  // (too large, nothing downloadable) instead of navigating to an error.
  app.get('/api/workspaces/:workspaceId/archive/summary', {
    preHandler: requireSession,
    handler: async (request) => {
      const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
      const { ids, folderId } = ArchiveQuery.parse(request.query);
      const plan = await documents.planArchive(workspaceId, currentUser(request).id, archiveSelection(ids, folderId));
      return {
        filename: plan.filename,
        files: plan.entries.length,
        bytes: plan.entries.reduce((sum, entry) => sum + entry.size, 0),
        skipped: plan.skipped.length,
      };
    },
  });

  // A zip of chosen documents, or of a folder and everything below it, streamed from storage.
  app.get('/api/workspaces/:workspaceId/archive', {
    preHandler: requireSession,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
      const { ids, folderId } = ArchiveQuery.parse(request.query);
      const release = archiveSlots.tryAcquire();
      if (!release) {
        throw Errors.busy('ARCHIVES_BUSY', 'The server is building other zip files. Please retry in a moment.', 10);
      }
      try {
        const userId = currentUser(request).id;
        const plan = await documents.planArchive(workspaceId, userId, archiveSelection(ids, folderId));
        await documents.recordArchiveDownload(workspaceId, userId, plan);
        const archive = await createArchiveStream(plan, storage, request.log);
        // The slot is held until the response ends, however it ends.
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) archive.abort();
          release();
        });
        reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', attachmentDisposition(plan.filename))
          .header('Cache-Control', 'private, no-store');
        if (archive.size !== null) reply.header('Content-Length', String(archive.size));
        return reply.send(archive.stream);
      } catch (error) {
        release();
        throw error;
      }
    },
  });

  // Rename and/or move to another folder (folderId: null = workspace root).
  app.patch('/api/documents/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = DocumentParams.parse(request.params);
      const user = currentUser(request);
      const changes = UpdateDocumentBody.parse(request.body);
      const document = await documents.update(id, user.id, changes);
      return { document: toDocumentDto(document) };
    },
  });

  // Move to trash. Revokes the document's share links; restorable for TRASH_RETENTION_DAYS.
  app.delete('/api/documents/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = DocumentParams.parse(request.params);
      return documents.trash(id, currentUser(request).id);
    },
  });

  app.put('/api/documents/:id/star', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = DocumentParams.parse(request.params);
      await documents.setStar(id, currentUser(request).id, true);
      return reply.status(204).send();
    },
  });

  app.delete('/api/documents/:id/star', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = DocumentParams.parse(request.params);
      await documents.setStar(id, currentUser(request).id, false);
      return reply.status(204).send();
    },
  });

  app.post('/api/documents/:id/restore', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = DocumentParams.parse(request.params);
      const document = await documents.restore(id, currentUser(request).id);
      return { document: toDocumentDto(document) };
    },
  });

  // Permanent delete of a trashed document. Owner only.
  app.delete('/api/documents/:id/permanent', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = DocumentParams.parse(request.params);
      await documents.purge(id, currentUser(request).id);
      return reply.status(204).send();
    },
  });

  // The live share links for a document. Tokens are never returned, only settings and activity.
  app.get('/api/documents/:id/shares', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = DocumentParams.parse(request.params);
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
          allowDownload: share.allow_download,
          allowedEmails: share.allowed_emails,
          activity,
        })),
      };
    },
  });
}
