import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { assertAllowedType } from '../../lib/mime';
import { Permissions, requireContributor } from '../../policy';
import { documentObjectKey } from '../../storage/keys';
import type { FileStorage } from '../../storage/file-storage';
import type { Clock, Membership, Role } from '../../types';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import type { AuditService } from '../audit/audit.service';
import { foldersRepo } from '../folders/folders.repo';
import type { NotificationsService } from '../notifications/notifications.service';
import { sharesRepo } from '../shares/shares.repo';
import {
  documentsRepo,
  type DocumentFilter,
  type DocumentListRow,
  type DocumentRow,
  type DocumentSort,
} from './documents.repo';

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
  trashRetentionDays: number;
  audit: AuditService;
  notifications: NotificationsService;
}

/** Opaque pagination cursor: the last row's sort value and id, base64url-encoded JSON. */
export function encodeCursor(row: DocumentListRow): string {
  return Buffer.from(JSON.stringify({ v: row.sort_value, id: row.id })).toString('base64url');
}

export function decodeCursor(cursor: string): { value: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v: unknown; id: unknown };
    if (typeof parsed.v !== 'string' || typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) {
      throw new Error('bad cursor');
    }
    return { value: parsed.v, id: parsed.id };
  } catch {
    throw Errors.badRequest('INVALID_CURSOR', 'The pagination cursor is not valid.');
  }
}

function cleanFilename(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!clean) throw Errors.badRequest('INVALID_NAME', 'A document needs a name.');
  return clean;
}

export function createDocumentsService(opts: DocumentsServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications } = opts;

  /**
   * Resolves a live document addressed by id alone and authorizes the caller against the
   * workspace recorded on the row. A non-member gets 404, identical to a document that does
   * not exist, and nothing is returned before this check passes.
   */
  async function authorizeById(documentId: string, userId: string): Promise<{ document: DocumentRow; role: Role }> {
    const document = await documentsRepo.findLiveById(pool, documentId);
    if (!document) throw Errors.notFound('Document');
    const role = await workspacesRepo.findMembership(pool, document.workspace_id, userId);
    if (!role) throw Errors.notFound('Document');
    return { document, role };
  }

  /** The same check for a document in the trash. */
  async function authorizeTrashedById(documentId: string, userId: string) {
    const document = await documentsRepo.findTrashedById(pool, documentId);
    if (!document) throw Errors.notFound('Document');
    const role = await workspacesRepo.findMembership(pool, document.workspace_id, userId);
    if (!role) throw Errors.notFound('Document');
    return { document, role };
  }

  /** A destination folder must exist in the document's own workspace. */
  async function requireFolderInWorkspace(workspaceId: string, folderId: string | null): Promise<void> {
    if (folderId === null) return;
    const folder = await foldersRepo.findInWorkspace(pool, workspaceId, folderId);
    if (!folder) throw Errors.notFound('Folder');
  }

  return {
    authorizeById,

    /**
     * Upload: validate user -> validate workspace -> validate file -> upload object ->
     * persist metadata.
     *
     * The object is written BEFORE the row. If the metadata insert then fails, the object is
     * deleted again, so a failed upload never leaves a half-created document.
     *
     * The file is buffered in memory first (at most MAX_UPLOAD_BYTES), which is what lets the
     * magic-byte check run against the real content before anything is stored. The route caps
     * how many uploads are buffered at once, so memory use stays bounded.
     */
    async upload(input: {
      membership: Membership;
      userId: string;
      userEmail: string;
      folderId: string | null;
      filename: string;
      declaredMimeType: string;
      body: Buffer;
      truncated: boolean;
    }) {
      requireContributor(input.membership.role, 'upload documents');

      if (input.truncated || input.body.length > opts.maxUploadBytes) {
        throw Errors.payloadTooLarge(opts.maxUploadBytes);
      }
      if (input.body.length === 0) {
        throw Errors.badRequest('EMPTY_FILE', 'The uploaded file is empty.');
      }

      await requireFolderInWorkspace(input.membership.workspaceId, input.folderId);

      // Never trust the client's declared Content-Type: check it against the real bytes.
      const mimeType = assertAllowedType(input.declaredMimeType, input.body.subarray(0, 4096));
      const filename = cleanFilename(input.filename);

      const documentId = randomUUID();
      const storageKey = documentObjectKey(input.membership.workspaceId, documentId);

      await storage.upload(storageKey, Readable.from(input.body), mimeType);

      try {
        const document = await documentsRepo.insert(pool, {
          id: documentId,
          workspaceId: input.membership.workspaceId,
          folderId: input.folderId,
          uploadedBy: input.userId,
          filename,
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
          title: `${filename} was added`,
          body: `${input.userEmail} uploaded a new document to this workspace.`,
          resourceId: document.id,
        });

        return document;
      } catch (error) {
        // Metadata failed: remove the object we just wrote so no orphan is left behind.
        await storage.delete(storageKey).catch((cleanupError: unknown) => {
          logger.error({ err: cleanupError, storageKey }, 'failed to clean up object after metadata insert failed');
        });
        throw error;
      }
    },

    /** One page of documents plus, for the first page of a folder, its subfolders and path. */
    async list(input: {
      membership: Membership;
      userId: string;
      view: 'active' | 'trash';
      folderId: string | null;
      search: string | null;
      filter: DocumentFilter;
      sort: DocumentSort;
      ascending: boolean;
      limit: number;
      cursor: string | null;
    }) {
      const { workspaceId } = input.membership;
      const searching = Boolean(input.search);

      const path =
        input.folderId && input.view === 'active'
          ? await foldersRepo.pathTo(pool, workspaceId, input.folderId)
          : [];
      if (input.folderId && input.view === 'active' && path.length === 0) {
        throw Errors.notFound('Folder');
      }

      // Fetch one extra row to know whether another page exists without a COUNT query.
      const rows = await documentsRepo.list(pool, {
        workspaceId,
        view: input.view,
        folderId: input.folderId,
        search: input.search,
        filter: input.filter,
        sort: input.sort,
        ascending: input.ascending,
        userId: input.userId,
        limit: input.limit + 1,
        after: input.cursor ? decodeCursor(input.cursor) : null,
      });

      const page = rows.slice(0, input.limit);
      const nextCursor = rows.length > input.limit ? encodeCursor(page[page.length - 1]!) : null;

      const showFolders = input.view === 'active' && !searching && input.filter === 'all' && !input.cursor;
      const folders = showFolders ? await foldersRepo.listChildren(pool, workspaceId, input.folderId) : [];
      const counts = await documentsRepo.counts(pool, workspaceId, input.userId);

      return { documents: page, nextCursor, folders, path, counts };
    },

    /**
     * Renames and/or moves a document. Both change metadata only: the object key is built
     * from UUIDs and never changes, so neither can move or overwrite bytes.
     */
    async update(documentId: string, userId: string, changes: { filename?: string; folderId?: string | null }) {
      const { document, role } = await authorizeById(documentId, userId);
      if (!Permissions.canModifyDocument(role, document.uploaded_by, userId)) {
        throw Errors.forbidden('Only the uploader or a workspace owner can change this document.');
      }

      const filename = changes.filename !== undefined ? cleanFilename(changes.filename) : undefined;
      const moving = changes.folderId !== undefined && changes.folderId !== document.folder_id;
      if (moving) await requireFolderInWorkspace(document.workspace_id, changes.folderId ?? null);

      const updated = await documentsRepo.update(pool, documentId, {
        filename,
        folderId: moving ? changes.folderId : undefined,
      });

      if (filename !== undefined && filename !== document.filename) {
        await audit.record({
          workspaceId: document.workspace_id,
          actorUserId: userId,
          action: 'document.renamed',
          resourceType: 'document',
          resourceId: documentId,
          metadata: { from: document.filename, to: filename, filename },
        });
      }
      if (moving) {
        await audit.record({
          workspaceId: document.workspace_id,
          actorUserId: userId,
          action: 'document.moved',
          resourceType: 'document',
          resourceId: documentId,
          metadata: { filename: updated.filename },
        });
      }
      return updated;
    },

    /**
     * Inline preview, for types that cannot execute script. Downloads are always forced to
     * `attachment`; preview is the one exception, limited to PDF and raster images, and still
     * served from the MinIO origin rather than the app origin.
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

    /** Authorize -> verify not trashed -> return a short-lived signed URL. */
    async getDownloadUrl(documentId: string, userId: string): Promise<string> {
      const { document } = await authorizeById(documentId, userId);
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
     * Moves a document to the trash.
     *
     * The bytes are kept, so the delete can be undone for TRASH_RETENTION_DAYS. Every share
     * link to the document is revoked in the same transaction, and restoring does NOT bring
     * them back: deleting a document is how people stop sharing it, and an undo should not
     * quietly re-open access someone meant to close.
     */
    async trash(documentId: string, userId: string) {
      const { document, role } = await authorizeById(documentId, userId);
      if (!Permissions.canModifyDocument(role, document.uploaded_by, userId)) {
        throw Errors.forbidden('Only the uploader or a workspace owner can delete this document.');
      }

      const now = clock.now();
      const revokedLinks = await withTransaction(pool, async (tx) => {
        const trashed = await documentsRepo.trash(tx, documentId, userId, now);
        if (!trashed) throw Errors.notFound('Document');
        const revoked = await sharesRepo.revokeForDocument(tx, documentId, now);
        await audit.record(
          {
            workspaceId: document.workspace_id,
            actorUserId: userId,
            action: 'document.trashed',
            resourceType: 'document',
            resourceId: documentId,
            metadata: { filename: document.filename, revokedLinks: revoked },
          },
          tx,
        );
        return revoked;
      });

      const purgeAt = new Date(now.getTime() + opts.trashRetentionDays * 86_400_000);
      return { revokedLinks, purgeAt };
    },

    async restore(documentId: string, userId: string) {
      const { document, role } = await authorizeTrashedById(documentId, userId);
      if (!Permissions.canModifyDocument(role, document.uploaded_by, userId)) {
        throw Errors.forbidden('Only the uploader or a workspace owner can restore this document.');
      }
      const restored = await documentsRepo.restore(pool, documentId);
      if (!restored) throw Errors.notFound('Document');
      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.restored',
        resourceType: 'document',
        resourceId: documentId,
        metadata: { filename: document.filename },
      });
      return restored;
    },

    /**
     * Permanently deletes a trashed document. Owner only.
     *
     * The object is removed before the row. The row is already invisible (it is in the trash),
     * so if the object delete fails the request fails and the document simply stays in the
     * trash to be retried, rather than leaving bytes that no row accounts for.
     */
    async purge(documentId: string, userId: string) {
      const { document, role } = await authorizeTrashedById(documentId, userId);
      if (!Permissions.canPurgeDocument(role)) {
        throw Errors.forbidden('Only a workspace owner can permanently delete documents.');
      }
      await storage.delete(document.storage_key);
      await documentsRepo.hardDelete(pool, documentId);
      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.purged',
        resourceType: 'document',
        resourceId: documentId,
        metadata: { filename: document.filename },
      });
    },

    /** Cleanup job: purges trash past retention. One failure never stops the rest. */
    async purgeExpiredTrash(batchSize = 100): Promise<{ purged: number; failed: number }> {
      const cutoff = new Date(clock.now().getTime() - opts.trashRetentionDays * 86_400_000);
      const expired = await documentsRepo.expiredTrash(pool, cutoff, batchSize);
      let purged = 0;
      let failed = 0;
      for (const document of expired) {
        try {
          await storage.delete(document.storage_key);
          await documentsRepo.hardDelete(pool, document.id);
          audit.recordAsync({
            workspaceId: document.workspace_id,
            actorUserId: null,
            action: 'document.purged',
            resourceType: 'document',
            resourceId: document.id,
            metadata: { filename: document.filename, reason: 'retention' },
          });
          purged += 1;
        } catch (error) {
          failed += 1;
          logger.error({ err: error, documentId: document.id }, 'failed to purge expired trash; will retry next run');
        }
      }
      return { purged, failed };
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
