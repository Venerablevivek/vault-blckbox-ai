import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { Errors } from '../../lib/errors';
import { assertAllowedType } from '../../lib/mime';
import { Permissions } from '../../policy';
import { documentObjectKey } from '../../storage/keys';
import type { FileStorage } from '../../storage/file-storage';
import type { Clock, Membership, Role } from '../../types';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { documentsRepo, type DocumentRow } from './documents.repo';

/** Types safe to render inline: none of them can carry executable script. */
export const PREVIEWABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface DocumentsServiceOptions {
  pool: Pool;
  storage: FileStorage;
  clock: Clock;
  logger: Logger;
  maxUploadBytes: number;
  signedUrlTtlSeconds: number;
  audit: AuditService;
  notifications: NotificationsService;
}

export function createDocumentsService(opts: DocumentsServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications } = opts;

  /**
   * Resolves a document addressed by id alone and authorizes the caller against the
   * workspace recorded on the row.
   *
   * DELETE /api/documents/:id and GET /api/documents/:id/download have no workspace in
   * their path (that is the API shape the blueprint specifies), so this is the single
   * place that check happens for both. A non-member gets 404, identical to a document
   * that does not exist.
   */
  async function authorizeById(
    documentId: string,
    userId: string,
  ): Promise<{ document: DocumentRow; role: Role }> {
    const document = await documentsRepo.findLiveById(pool, documentId);
    if (!document) throw Errors.notFound('Document');

    const role = await workspacesRepo.findMembership(pool, document.workspace_id, userId);
    if (!role) throw Errors.notFound('Document');

    return { document, role };
  }

  return {
    authorizeById,

    /**
     * Upload: validate user -> validate workspace -> validate file -> upload object ->
     * persist metadata.
     *
     * The object is written BEFORE the row. If the metadata insert then fails, the object
     * is deleted again — so a failed upload never leaves a half-created document. The
     * reverse order would leave a row pointing at bytes that do not exist, which is a 500
     * on every later download.
     *
     * The file is buffered in memory first. At a 25 MB cap this is a deliberate trade:
     * it is what allows the magic-byte check to run against the real content before
     * anything is written to storage, and it gives an exact size for the row. It would be
     * the wrong call for multi-gigabyte uploads.
     */
    async upload(input: {
      membership: Membership;
      userId: string;
      userEmail: string;
      filename: string;
      declaredMimeType: string;
      body: Buffer;
      truncated: boolean;
    }) {
      if (!Permissions.canUpload(input.membership.role)) {
        throw Errors.forbidden('You do not have permission to upload to this workspace.');
      }

      // @fastify/multipart sets `truncated` when the configured byte limit was hit, so
      // an oversize body is rejected without ever being fully read into memory.
      if (input.truncated || input.body.length > opts.maxUploadBytes) {
        throw Errors.payloadTooLarge(opts.maxUploadBytes);
      }
      if (input.body.length === 0) {
        throw Errors.badRequest('EMPTY_FILE', 'The uploaded file is empty.');
      }

      // Never trust the client's declared Content-Type: check it against the real bytes.
      const mimeType = assertAllowedType(input.declaredMimeType, input.body.subarray(0, 4096));

      const documentId = randomUUID();
      const storageKey = documentObjectKey(input.membership.workspaceId, documentId);

      await storage.upload(storageKey, Readable.from(input.body), mimeType);

      try {
        const document = await documentsRepo.insert(pool, {
          id: documentId,
          workspaceId: input.membership.workspaceId,
          uploadedBy: input.userId,
          filename: input.filename,
          storageKey,
          mimeType,
          size: input.body.length,
        });

        await audit.record({
          workspaceId: input.membership.workspaceId,
          actorUserId: input.userId,
          action: 'document.uploaded',
          resourceType: 'document',
          resourceId: document.id,
          metadata: { filename: document.filename, size: input.body.length },
        });

        notifications.notifyWorkspace(input.membership.workspaceId, input.userId, {
          type: 'document.uploaded',
          title: `${input.filename} was added`,
          body: `${input.userEmail} uploaded a new document to this workspace.`,
          resourceId: document.id,
        });

        return document;
      } catch (error) {
        // Metadata failed: remove the object we just wrote so no orphan is left behind.
        await storage.delete(storageKey).catch((cleanupError: unknown) => {
          logger.error(
            { err: cleanupError, storageKey },
            'failed to clean up object after metadata insert failed',
          );
        });
        throw error;
      }
    },

    async list(workspaceId: string) {
      return documentsRepo.listByWorkspace(pool, workspaceId);
    },

    /**
     * Renames a document. The name is display metadata only — the object key is built from
     * UUIDs and never changes, so a rename can never move or overwrite bytes.
     */
    async rename(documentId: string, userId: string, filename: string): Promise<DocumentRow> {
      const { document, role } = await authorizeById(documentId, userId);
      if (!Permissions.canRenameDocument(role, document.uploaded_by, userId)) {
        throw Errors.forbidden('Only the uploader or the workspace owner can rename this document.');
      }

      const clean = filename.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!clean) throw Errors.badRequest('INVALID_NAME', 'A document needs a name.');

      await documentsRepo.rename(pool, documentId, clean);
      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.renamed',
        resourceType: 'document',
        resourceId: documentId,
        metadata: { from: document.filename, to: clean, filename: clean },
      });
      return { ...document, filename: clean };
    },

    /**
     * Inline preview, for types that cannot execute script.
     *
     * Downloads are forced to `attachment` so a hostile file can never render. Preview is
     * the deliberate exception, and it is only granted to PDF and raster images — both of
     * which were magic-byte verified at upload, and both still served from the MinIO
     * origin rather than the app origin, so even an exploit could not reach the session
     * cookie. Text formats are excluded: browsers sniff them.
     */
    async getPreviewUrl(documentId: string, userId: string): Promise<string> {
      const { document } = await authorizeById(documentId, userId);
      if (!PREVIEWABLE.has(document.mime_type)) {
        throw Errors.unsupportedMediaType('This type of file cannot be previewed. Download it instead.');
      }

      audit.recordAsync({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.previewed',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { filename: document.filename },
      });

      return storage.getSignedUrl(document.storage_key, opts.signedUrlTtlSeconds, {
        filename: document.filename,
        contentType: document.mime_type,
        disposition: 'inline',
      });
    },

    /** Authorize -> verify not deleted -> return a short-lived signed URL. */
    async getDownloadUrl(documentId: string, userId: string): Promise<string> {
      const { document } = await authorizeById(documentId, userId);

      // Fire-and-forget: a download is a read, and the trail must not stand between a
      // member and a document they are entitled to.
      audit.recordAsync({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.downloaded',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { filename: document.filename },
      });

      return storage.getSignedUrl(document.storage_key, opts.signedUrlTtlSeconds, {
        filename: document.filename,
        contentType: document.mime_type,
      });
    },

    /**
     * Soft-delete the metadata, then remove the underlying object.
     *
     * The row is committed first, so the document becomes unreachable — from listing,
     * download and every share link pointing at it — before the bytes are touched. If the
     * object deletion then fails, the key is logged for manual cleanup rather than leaving
     * the user with an error for something that has, from their point of view, worked.
     */
    async remove(documentId: string, userId: string): Promise<void> {
      const { document, role } = await authorizeById(documentId, userId);

      if (!Permissions.canDeleteDocument(role, document.uploaded_by, userId)) {
        throw Errors.forbidden('Only the uploader or the workspace owner can delete this document.');
      }

      const deleted = await documentsRepo.softDelete(pool, documentId, clock.now());
      if (!deleted) throw Errors.notFound('Document');

      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.deleted',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { filename: document.filename },
      });

      try {
        await storage.delete(document.storage_key);
      } catch (error) {
        logger.error(
          { err: error, storageKey: document.storage_key, documentId },
          'document soft-deleted but object removal failed; key needs manual cleanup',
        );
      }
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
