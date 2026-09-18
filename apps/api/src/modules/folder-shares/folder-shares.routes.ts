import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../../config';
import {
  CreateFolderShareBody,
  FolderShareBrowseQuery,
  FolderShareDocumentParams,
  FolderShareIdParams,
  WorkspaceFolderParams,
} from '../../contracts/folder-shares';
import { ShareTokenParams, UnlockBody } from '../../contracts/shares';
import { Errors } from '../../lib/errors';
import { createSlots } from '../../lib/slots';
import { currentUser, requireSession } from '../../plugins/session';
import type { FileStorage } from '../../storage/file-storage';
import { createArchiveStream } from '../documents/archive';
import { attachmentDisposition } from '../documents/documents.routes';
import type { Visitor } from '../shares/shares.service';
import type { FolderShareRow } from './folder-shares.repo';
import { folderGrantCookieName, type FolderSharesService } from './folder-shares.service';

function visitorOf(request: FastifyRequest): Visitor {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const summaryOf = (share: FolderShareRow) => ({
  id: share.id,
  createdBy: share.created_by,
  createdAt: share.created_at,
  expiresAt: share.expires_at,
  hasPassword: share.password_hash !== null,
  opens: share.opens,
  downloads: share.downloads,
  lastAccessedAt: share.last_accessed_at,
});

export function registerFolderShareRoutes(
  app: FastifyInstance,
  deps: { config: Config; folderShares: FolderSharesService; storage: FileStorage },
): void {
  const { config, folderShares, storage } = deps;
  const grantOf = (request: FastifyRequest, token: string) => request.cookies[folderGrantCookieName(token)];
  // Zips from folder links share the cap with the workspace's own zip downloads' setting.
  const archiveSlots = createSlots(config.MAX_CONCURRENT_ARCHIVES);

  app.post('/api/folder-shares', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const body = CreateFolderShareBody.parse(request.body);
      const user = currentUser(request);
      if (!user.emailVerified) throw Errors.emailNotVerified('create share links');
      const { share, url } = await folderShares.create({ ...body, userId: user.id });
      return reply.status(201).send({
        share: {
          id: share.id,
          url,
          expiresAt: share.expires_at,
          createdAt: share.created_at,
          hasPassword: share.password_hash !== null,
        },
      });
    },
  });

  app.get('/api/workspaces/:workspaceId/folders/:folderId/shares', {
    preHandler: requireSession,
    handler: async (request) => {
      const { workspaceId, folderId } = WorkspaceFolderParams.parse(request.params);
      const shares = await folderShares.listForFolder(workspaceId, folderId, currentUser(request).id);
      return { shares: shares.map(summaryOf) };
    },
  });

  app.delete('/api/folder-shares/:id', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = FolderShareIdParams.parse(request.params);
      await folderShares.revoke(id, currentUser(request).id);
      return reply.status(204).send();
    },
  });

  /* Public routes: no session. Each is rate limited per client IP. */

  app.get('/api/folder-shares/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { folderId } = FolderShareBrowseQuery.parse(request.query);
      return folderShares.browse(token, grantOf(request, token), folderId);
    },
  });

  app.post('/api/folder-shares/:token/unlock', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { password } = UnlockBody.parse(request.body);
      const result = await folderShares.unlock(token, password);
      if (result.grant) {
        reply.setCookie(folderGrantCookieName(token), result.grant, {
          httpOnly: true,
          sameSite: 'lax',
          secure: config.SESSION_COOKIE_SECURE,
          path: '/',
          maxAge: result.maxAgeSeconds,
        });
      }
      return reply.status(204).send();
    },
  });

  app.post('/api/folder-shares/:token/view', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      await folderShares.recordView(token, visitorOf(request), grantOf(request, token));
      return reply.status(204).send();
    },
  });

  app.get('/api/folder-shares/:token/documents/:documentId/download', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token, documentId } = FolderShareDocumentParams.parse(request.params);
      const url = await folderShares.downloadUrl(token, documentId, visitorOf(request), grantOf(request, token));
      return reply.redirect(url, 302);
    },
  });

  app.get('/api/folder-shares/:token/archive/summary', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { folderId } = FolderShareBrowseQuery.parse(request.query);
      const plan = await folderShares.planArchive(token, grantOf(request, token), folderId);
      return {
        filename: plan.filename,
        files: plan.entries.length,
        bytes: plan.entries.reduce((sum, entry) => sum + entry.size, 0),
        skipped: plan.skipped.length,
      };
    },
  });

  app.get('/api/folder-shares/:token/archive', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { folderId } = FolderShareBrowseQuery.parse(request.query);
      const release = archiveSlots.tryAcquire();
      if (!release) {
        throw Errors.busy('ARCHIVES_BUSY', 'The server is building other zip files. Please retry in a moment.', 10);
      }
      try {
        const grant = grantOf(request, token);
        const plan = await folderShares.planArchive(token, grant, folderId);
        await folderShares.recordArchive(token, grant, visitorOf(request), plan);
        const archive = await createArchiveStream(plan, storage, request.log);
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
}
