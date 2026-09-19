import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../../db/pool';
import { withTenant } from '../../db/tenant';
import { withTransaction } from '../../db/tx';
import { AppError, Errors } from '../../lib/errors';
import { assertAllowedType } from '../../lib/mime';
import { stripControlCharacters } from '../../lib/text';
import { Permissions, requireContributor } from '../../policy';
import { derivedObjectKey, documentObjectKey, documentVersionObjectKey } from '../../storage/keys';
import { extractText } from '../../processing/text';
import { makeThumbnail } from '../../processing/thumbnail';
import { OFFICE_TYPES, officeExtension, type OfficeConverter } from '../../processing/office';
import type { FileStorage } from '../../storage/file-storage';
import type { Clock, Membership, Role } from '../../types';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import type { AuditService } from '../audit/audit.service';
import { foldersRepo } from '../folders/folders.repo';
import type { NotificationsService } from '../notifications/notifications.service';
import { sharesRepo } from '../shares/shares.repo';
import type { JobQueue } from '../../jobs/queue';
import type { Scanner } from '../../scanning/scanner';
import { assertScanAllows, initialScanStatus, type ScanStatus } from './scan-policy';
import { planArchive, type ArchivePlan } from './archive';
import { versionsRepo, type VersionRow } from './versions.repo';
import { commentsRepo, type CommentRow } from './comments.repo';
import {
  documentsRepo,
  type DocumentFilter,
  type DocumentListRow,
  type DocumentRow,
  type DocumentSort,
} from './documents.repo';

/** Types safe to render inline: none of them can carry executable script. */
export const PREVIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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
  jobs: JobQueue;
  scanMode: 'off' | 'clamav';
  scanMaxBytes: number;
  /** Null when scanning is off. */
  scanner: Scanner | null;
  archiveMaxFiles: number;
  archiveMaxBytes: number;
  /** Earlier versions kept per document; older ones are removed when a new version arrives. */
  maxVersions: number;
  /** Largest file the worker reads for a thumbnail and search text; each is held in memory. */
  processingMaxBytes: number;
  /** Converts Office files to PDF for previews; null when office previews are off. */
  officeConverter: OfficeConverter | null;
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

/** S3 reports a missing object as NoSuchKey on GET, and a bare 404 on HEAD. */
export function isMissingObject(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export function cleanFilename(name: string): string {
  const clean = stripControlCharacters(name).trim();
  if (!clean) throw Errors.badRequest('INVALID_NAME', 'A document needs a name.');
  return clean;
}

export type BulkAction = 'trash' | 'restore' | 'delete' | 'move';

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: { code: string; message: string };
}

/** The most comments one document can hold; also the most a listing returns. */
const MAX_COMMENTS = 500;

/** Trims a comment and drops control characters other than line breaks and tabs. */
function cleanCommentBody(body: string): string {
  const text = body
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim();
  if (!text) throw Errors.badRequest('EMPTY_COMMENT', 'Write something first.');
  return text;
}

export function createDocumentsService(opts: DocumentsServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications, jobs } = opts;

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

  /**
   * Deletes the objects of a document's earlier versions. Called before its row goes (the rows
   * cascade with it). Deleting an object that is already gone succeeds, so a retry after a
   * partial failure simply carries on.
   */
  async function deleteVersionObjects(documentId: string): Promise<void> {
    for (const key of await versionsRepo.storageKeys(pool, documentId)) await storage.delete(key);
    for (const key of await documentsRepo.derivedKeys(pool, documentId)) await storage.delete(key);
  }

  /** Deletes objects nothing points at any more (old thumbnails and previews). Best effort. */
  function deleteQuietly(keys: Array<string | null>): void {
    for (const key of keys) {
      if (!key) continue;
      void storage.delete(key).catch((error: unknown) => {
        logger.warn({ err: error, storageKey: key }, 'failed to delete a derived object');
      });
    }
  }

  /** Queues the worker to derive a thumbnail and search text, once the file may be read. */
  async function enqueueProcessing(db: Db, documentId: string): Promise<void> {
    await jobs.enqueue(db, 'document.process', { documentId }, { dedupeKey: documentId, maxAttempts: 3 });
  }

  /** Removes an earlier version: its row and quota first, then its object. */
  async function removeVersion(version: VersionRow): Promise<void> {
    const removed = await withTransaction(pool, async (tx) => {
      const row = await versionsRepo.delete(tx, version.id);
      if (row && row.scan_status !== 'infected') {
        await workspacesRepo.releaseStorage(tx, row.workspace_id, Number(row.size));
      }
      return row;
    });
    if (!removed) return;
    // Row first: a failure here leaves an unreachable object behind (logged), never a version
    // in the list that can't be downloaded.
    await storage.delete(removed.storage_key).catch((error: unknown) => {
      logger.error({ err: error, storageKey: removed.storage_key }, 'failed to delete an earlier version object');
    });
  }

  /**
   * Makes new content the current version: the object is already in storage under `storageKey`.
   * In one transaction: re-reads and locks the document, reserves quota, moves the current
   * content into history (unless malware removed it), and points the document at the new object.
   * If anything fails the new object is deleted again. Then prunes versions beyond the limit.
   */
  async function replaceCurrent(input: {
    document: DocumentRow;
    userId: string;
    storageKey: string;
    size: number;
    sha256: Buffer | null;
    scanStatus: ScanStatus;
    audit: { action: 'document.version_uploaded' | 'document.version_restored'; metadata: Record<string, unknown> };
    notifyAs?: string;
  }): Promise<DocumentRow> {
    const now = clock.now();
    let updated: DocumentRow;
    let staleDerived: Array<string | null> = [];
    try {
      updated = await withTransaction(pool, async (tx) => {
        const current = await versionsRepo.lockLive(tx, input.document.id);
        if (!current) throw Errors.notFound('Document');
        if (current.storage_key !== input.document.storage_key) {
          throw Errors.conflict('VERSION_CONFLICT', 'Someone else changed this document just now. Please try again.');
        }
        if (!(await workspacesRepo.reserveStorage(tx, current.workspace_id, input.size))) {
          const latest = await workspacesRepo.storageUsage(tx, current.workspace_id);
          throw Errors.quotaExceeded(latest.usedBytes, latest.quotaBytes);
        }
        if (current.scan_status !== 'infected') await versionsRepo.archiveCurrent(tx, randomUUID(), current);
        staleDerived = [current.thumbnail_key, current.preview_key];
        await documentsRepo.deleteContents(tx, current.id);
        const row = await versionsRepo.setCurrent(tx, current.id, {
          storageKey: input.storageKey,
          size: input.size,
          sha256: input.sha256,
          scanStatus: input.scanStatus,
          version: current.version + 1,
          uploadedBy: input.userId,
          at: now,
        });
        if (row.scan_status === 'pending') {
          await jobs.enqueue(tx, 'document.scan', { documentId: row.id }, { dedupeKey: row.id, maxAttempts: 8 });
        } else {
          await enqueueProcessing(tx, row.id);
        }
        await audit.record(
          {
            workspaceId: row.workspace_id,
            actorUserId: input.userId,
            action: input.audit.action,
            resourceType: 'document',
            resourceId: row.id,
            metadata: { filename: row.filename, version: row.version, ...input.audit.metadata },
          },
          tx,
        );
        if (input.notifyAs) {
          await notifications.notifyWorkspace(tx, row.workspace_id, input.userId, {
            type: 'document.uploaded',
            title: `${row.filename} was updated`,
            body: `${input.notifyAs} uploaded version ${row.version}.`,
            resourceId: row.id,
          });
        }
        return row;
      });
    } catch (error) {
      await storage.delete(input.storageKey).catch((cleanupError: unknown) => {
        logger.error({ err: cleanupError, storageKey: input.storageKey }, 'failed to clean up a version object');
      });
      throw error;
    }

    deleteQuietly(staleDerived);
    for (const old of await versionsRepo.beyond(pool, updated.id, opts.maxVersions)) {
      await removeVersion(old).catch((error: unknown) => {
        logger.error({ err: error, versionId: old.id }, 'failed to prune an old version');
      });
    }
    touchRecent(input.userId, updated.id);
    return updated;
  }

  /** Authorizes a change to a live document's content: the uploader or an owner. */
  async function authorizeContentChange(documentId: string, userId: string) {
    const { document, role } = await authorizeById(documentId, userId);
    requireContributor(role, 'change documents');
    if (!Permissions.canModifyDocument(role, document.uploaded_by, userId)) {
      throw Errors.forbidden('Only the uploader or a workspace owner can change this document.');
    }
    return document;
  }

  /** Removes a trashed row and gives its bytes back to the workspace quota, atomically. */
  async function deleteTrashedRow(documentId: string): Promise<void> {
    await withTransaction(pool, async (tx) => {
      const deleted = await documentsRepo.hardDelete(tx, documentId);
      if (deleted) await workspacesRepo.releaseStorage(tx, deleted.workspace_id, Number(deleted.size));
    });
  }

  /**
   * Computes a document's SHA-256 by streaming its object back from storage, so memory stays
   * flat however large the file is. A no-op for a document that is gone or already has one.
   */
  async function computeChecksum(documentId: string): Promise<void> {
    const row = await documentsRepo.findAnyById(pool, documentId);
    if (!row || row.sha256) return;
    const hash = createHash('sha256');
    try {
      for await (const chunk of await storage.download(row.storage_key)) hash.update(chunk as Buffer);
    } catch (error) {
      if (!isMissingObject(error) || !row.deleted_at) throw error;
      // A trashed document whose bytes are already gone can never be restored. Before the trash
      // existed, deleting removed the object straight away, and those rows became "trashed" when
      // the trash was introduced. Finish deleting them rather than retrying forever.
      await deleteVersionObjects(row.id);
      await deleteTrashedRow(row.id);
      audit.recordAsync({
        workspaceId: row.workspace_id,
        actorUserId: null,
        action: 'document.purged',
        resourceType: 'document',
        resourceId: row.id,
        metadata: { filename: row.filename, reason: 'object_missing' },
      });
      logger.warn({ documentId: row.id }, 'removed a trashed document whose object no longer exists');
      return;
    }
    await documentsRepo.setChecksum(pool, row.id, row.storage_key, hash.digest());
  }

  /** Whether storage still has an object: fetches it and discards the stream straight away. */
  async function objectExists(key: string): Promise<boolean> {
    try {
      (await storage.download(key)).destroy();
      return true;
    } catch (error) {
      if (isMissingObject(error)) return false;
      throw error;
    }
  }

  /**
   * Finishes deleting a workspace: objects first, then their rows, a batch at a time; the
   * workspace row goes last, cascading folders, audit trail and notifications. If storage fails
   * part-way the error propagates, the remaining rows still point at their objects, and a retry
   * continues where this stopped. Only acts on a workspace already marked deleted.
   */
  async function purgeWorkspace(workspaceId: string, batchSize = 200): Promise<number> {
    if (!(await workspacesRepo.isMarkedDeleted(pool, workspaceId))) return 0;
    let objects = 0;
    for (;;) {
      const rows = await documentsRepo.anyInWorkspace(pool, workspaceId, batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        await deleteVersionObjects(row.id);
        await storage.delete(row.storage_key);
        await documentsRepo.deleteRow(pool, row.id);
        objects += 1;
      }
    }
    await workspacesRepo.deleteRow(pool, workspaceId);
    return objects;
  }

  /** Remembers that a person opened a document, for their Recent view. Best effort. */
  function touchRecent(userId: string, documentId: string): void {
    void documentsRepo.touchRecent(pool, userId, documentId, clock.now()).catch((error: unknown) => {
      logger.warn({ err: error, documentId }, 'failed to record a recent document');
    });
  }

  /** A destination folder must exist in the document's own workspace. */
  async function requireFolderInWorkspace(workspaceId: string, folderId: string | null): Promise<void> {
    if (folderId === null) return;
    const folder = await foldersRepo.findInWorkspace(pool, workspaceId, folderId);
    if (!folder) throw Errors.notFound('Folder');
  }

  const service = {
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

      const { workspaceId } = input.membership;
      const size = input.body.length;

      // Cheap early refusal, before any bytes are written. The authoritative check is the
      // conditional reservation inside the transaction below.
      const usage = await workspacesRepo.storageUsage(pool, workspaceId);
      if (usage.usedBytes + size > usage.quotaBytes) throw Errors.quotaExceeded(usage.usedBytes, usage.quotaBytes);

      const sha256 = createHash('sha256').update(input.body).digest();
      const documentId = randomUUID();
      const storageKey = documentObjectKey(workspaceId, documentId);

      await storage.upload(storageKey, Readable.from(input.body), mimeType);

      try {
        // Quota, row and audit entry commit together: if any of them fails, none exist, and
        // the catch below removes the object.
        const document = await withTransaction(pool, async (tx) => {
          if (!(await workspacesRepo.reserveStorage(tx, workspaceId, size))) {
            const latest = await workspacesRepo.storageUsage(tx, workspaceId);
            throw Errors.quotaExceeded(latest.usedBytes, latest.quotaBytes);
          }
          const row = await documentsRepo.insert(tx, {
            id: documentId,
            workspaceId,
            folderId: input.folderId,
            uploadedBy: input.userId,
            filename,
            storageKey,
            mimeType,
            size,
            sha256,
            scanStatus: initialScanStatus(opts.scanMode, size, opts.scanMaxBytes),
          });
          if (row.scan_status === 'pending') {
            await jobs.enqueue(tx, 'document.scan', { documentId: row.id }, { dedupeKey: row.id, maxAttempts: 8 });
          } else {
            await enqueueProcessing(tx, row.id);
          }
          await audit.record(
            {
              workspaceId,
              actorUserId: input.userId,
              action: 'document.uploaded',
              resourceType: 'document',
              resourceId: row.id,
              metadata: { filename: row.filename, size },
            },
            tx,
          );
          await notifications.notifyWorkspace(tx, workspaceId, input.userId, {
            type: 'document.uploaded',
            title: `${filename} was added`,
            body: `${input.userEmail} uploaded a new document to this workspace.`,
            resourceId: row.id,
          });
          return row;
        });

        // Identical content is allowed (people keep copies on purpose), but worth pointing out.
        const duplicateOf = await documentsRepo.findByChecksum(pool, workspaceId, sha256, document.id);
        touchRecent(input.userId, document.id);
        return { document, duplicateOf };
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
      // Row-level security narrows every read here to the caller's workspaces (see withTenant).
      return withTenant(pool, input.userId, async (db) => {
        const { workspaceId } = input.membership;
        const searching = Boolean(input.search);

        const path =
          input.folderId && input.view === 'active' ? await foldersRepo.pathTo(db, workspaceId, input.folderId) : [];
        if (input.folderId && input.view === 'active' && path.length === 0) {
          throw Errors.notFound('Folder');
        }

        // Fetch one extra row to know whether another page exists without a COUNT query.
        const rows = await documentsRepo.list(db, {
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
        const folders = showFolders ? await foldersRepo.listChildren(db, workspaceId, input.folderId) : [];
        // Tab counts cover the whole workspace, so they are computed once, for the first page; the
        // client keeps them while it scrolls through later pages.
        const counts = input.cursor ? null : await documentsRepo.counts(db, workspaceId, input.userId);

        return { documents: page, nextCursor, folders, path, counts };
      });
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
      assertScanAllows(document);
      touchRecent(userId, document.id);
      const officePreview = !PREVIEWABLE.has(document.mime_type) && document.preview_key !== null;
      if (!PREVIEWABLE.has(document.mime_type) && !officePreview) {
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
      // An Office file is shown as the PDF the converter made of it.
      return officePreview
        ? storage.getSignedUrl(document.preview_key!, opts.signedUrlTtlSeconds, {
            filename: `${document.filename.replace(/\.[^.]+$/, '')}.pdf`,
            contentType: 'application/pdf',
            disposition: 'inline',
          })
        : storage.getSignedUrl(document.storage_key, opts.signedUrlTtlSeconds, {
            filename: document.filename,
            contentType: document.mime_type,
            disposition: 'inline',
          });
    },

    /** Authorize -> verify not trashed -> return a short-lived signed URL. */
    async getDownloadUrl(documentId: string, userId: string): Promise<string> {
      const { document } = await authorizeById(documentId, userId);
      assertScanAllows(document);
      touchRecent(userId, document.id);
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
      if (!(await objectExists(document.storage_key))) {
        throw new AppError(
          410,
          'DOCUMENT_FILE_MISSING',
          "This document's file no longer exists, so it can't be restored.",
        );
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
      await deleteVersionObjects(document.id);
      await storage.delete(document.storage_key);
      await deleteTrashedRow(document.id);
      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.purged',
        resourceType: 'document',
        resourceId: documentId,
        metadata: { filename: document.filename },
      });
    },

    /**
     * Cleanup job: computes checksums for documents stored before checksums existed, a small
     * batch per run, by reading the object back from storage.
     */
    async backfillChecksums(batchSize = 20): Promise<{ updated: number; failed: number }> {
      const rows = await documentsRepo.missingChecksums(pool, batchSize);
      let updated = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          await computeChecksum(row.id);
          updated += 1;
        } catch (error) {
          failed += 1;
          logger.error({ err: error, documentId: row.id }, 'failed to compute checksum; will retry next run');
        }
      }
      return { updated, failed };
    },

    /**
     * Cleanup job: finishes deleting workspaces. Objects first, then rows, a batch at a time;
     * the workspace row goes last, cascading its folders, audit trail and notifications. If
     * storage fails part-way, the remaining documents are still recorded and the next run
     * continues where this one stopped.
     */
    async purgeDeletedWorkspaces(maxWorkspaces = 5): Promise<{ workspaces: number; objects: number }> {
      let workspacesPurged = 0;
      let objects = 0;
      for (const { id } of await workspacesRepo.deletedWorkspaces(pool, maxWorkspaces)) {
        try {
          objects += await purgeWorkspace(id);
          workspacesPurged += 1;
        } catch (error) {
          logger.error({ err: error, workspaceId: id }, 'failed to purge deleted workspace; will retry next run');
        }
      }
      return { workspaces: workspacesPurged, objects };
    },

    computeChecksum,
    purgeWorkspace,
    touchRecent,

    /** Stars or unstars a document for the caller. Any member may star what they can see. */
    /**
     * Works out what a zip download of some documents, or of a folder and everything below it,
     * will contain. Nothing is read from storage yet. Files the malware scan hasn't cleared are
     * left out and named in the archive instead, so one pending file doesn't block the rest.
     * Reads and records nothing: see recordArchiveDownload.
     */
    async planArchive(
      workspaceId: string,
      userId: string,
      selection: { ids: string[] } | { folderId: string },
    ): Promise<ArchivePlan> {
      if (!(await workspacesRepo.findMembership(pool, workspaceId, userId))) throw Errors.notFound('Workspace');
      const limit = opts.archiveMaxFiles + 1;

      let filename: string;
      let rows;
      if ('folderId' in selection) {
        const folder = await foldersRepo.findInWorkspace(pool, workspaceId, selection.folderId);
        if (!folder) throw Errors.notFound('Folder');
        filename = `${folder.name}.zip`;
        rows = await withTenant(pool, userId, (db) =>
          documentsRepo.archiveFolder(db, workspaceId, selection.folderId, limit),
        );
        if (rows.length === 0) throw Errors.conflict('NOTHING_TO_DOWNLOAD', 'This folder has no files in it.');
      } else {
        filename = `documents-${clock.now().toISOString().slice(0, 10)}.zip`;
        rows = await withTenant(pool, userId, (db) =>
          documentsRepo.archiveByIds(db, workspaceId, selection.ids, limit),
        );
        if (rows.length === 0) throw Errors.notFound('Document');
      }

      if (rows.length > opts.archiveMaxFiles) {
        throw new AppError(
          413,
          'ARCHIVE_TOO_LARGE',
          `A zip download can hold at most ${opts.archiveMaxFiles} files. Download a smaller folder or selection.`,
        );
      }
      const plan = planArchive(filename, rows);
      if (plan.entries.length === 0) {
        throw Errors.conflict(
          'NOTHING_TO_DOWNLOAD',
          'None of these files can be downloaded: they are still being checked for malware, or malware was found.',
        );
      }
      const totalBytes = plan.entries.reduce((sum, entry) => sum + entry.size, 0);
      if (totalBytes > opts.archiveMaxBytes) {
        throw new AppError(
          413,
          'ARCHIVE_TOO_LARGE',
          `A zip download can hold at most ${(opts.archiveMaxBytes / 1024 ** 3).toFixed(1)} GB. Download a smaller folder or selection.`,
        );
      }
      return plan;
    },

    /** Records each file in a zip as downloaded by the person who asked for it. */
    async recordArchiveDownload(workspaceId: string, userId: string, plan: ArchivePlan): Promise<void> {
      await withTransaction(pool, async (tx) => {
        for (const entry of plan.entries) {
          await audit.record(
            {
              workspaceId,
              actorUserId: userId,
              action: 'document.downloaded',
              resourceType: 'document',
              resourceId: entry.id,
              metadata: { filename: entry.path.slice(entry.path.lastIndexOf('/') + 1), archive: plan.filename },
            },
            tx,
          );
        }
      });
    },

    /**
     * Applies one action to many documents. Each is authorized and carried out on its own,
     * exactly as the single-document endpoint would, so one the caller may not touch fails
     * alone and the rest still go through. Results come back in the order the ids were given.
     */
    async bulk(userId: string, action: BulkAction, ids: string[], folderId: string | null): Promise<BulkResult[]> {
      const results: BulkResult[] = [];
      for (const id of ids) {
        try {
          if (action === 'trash') await service.trash(id, userId);
          else if (action === 'restore') await service.restore(id, userId);
          else if (action === 'delete') await service.purge(id, userId);
          else await service.update(id, userId, { folderId });
          results.push({ id, ok: true });
        } catch (error) {
          if (!(error instanceof AppError)) {
            logger.error({ err: error, documentId: id, action }, 'bulk action failed');
            results.push({ id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
          } else {
            results.push({ id, ok: false, error: { code: error.code, message: error.message } });
          }
        }
      }
      return results;
    },

    /**
     * Uploads new content for a document, which becomes its current version; the previous one is
     * kept in its history. Same checks as an upload (size, real type, quota, malware scan), plus:
     * the type must match the document's, and content identical to the current version, or a
     * current version still being scanned, is refused.
     */
    async uploadVersion(input: {
      documentId: string;
      userId: string;
      userEmail: string;
      declaredMimeType: string;
      body: Buffer;
      truncated: boolean;
    }): Promise<DocumentRow> {
      const document = await authorizeContentChange(input.documentId, input.userId);
      if (input.truncated || input.body.length > opts.maxUploadBytes) throw Errors.payloadTooLarge(opts.maxUploadBytes);
      if (input.body.length === 0) throw Errors.badRequest('EMPTY_FILE', 'The uploaded file is empty.');
      if (document.scan_status === 'pending') {
        throw Errors.conflict(
          'SCAN_PENDING',
          'The current version is still being checked for malware. Try again in a moment.',
        );
      }
      const mimeType = assertAllowedType(input.declaredMimeType, input.body.subarray(0, 4096));
      if (mimeType !== document.mime_type) {
        throw Errors.unsupportedMediaType(
          `A new version must be the same type of file as the document (${document.mime_type}). Upload it as a new document instead.`,
        );
      }
      const sha256 = createHash('sha256').update(input.body).digest();
      if (document.sha256 && sha256.equals(document.sha256)) {
        throw Errors.conflict('VERSION_UNCHANGED', 'This file is identical to the current version.');
      }
      const usage = await workspacesRepo.storageUsage(pool, document.workspace_id);
      if (usage.usedBytes + input.body.length > usage.quotaBytes) {
        throw Errors.quotaExceeded(usage.usedBytes, usage.quotaBytes);
      }

      const storageKey = documentVersionObjectKey(document.workspace_id, document.id, randomUUID());
      await storage.upload(storageKey, Readable.from(input.body), mimeType);
      return replaceCurrent({
        document,
        userId: input.userId,
        storageKey,
        size: input.body.length,
        sha256,
        scanStatus: initialScanStatus(opts.scanMode, input.body.length, opts.scanMaxBytes),
        audit: { action: 'document.version_uploaded', metadata: { size: input.body.length } },
        notifyAs: input.userEmail,
      });
    },

    /** The document's versions, current first, for any member of its workspace. */
    async listVersions(documentId: string, userId: string) {
      const { document } = await authorizeById(documentId, userId);
      const [history, uploader] = await Promise.all([
        versionsRepo.list(pool, document.id),
        workspacesRepo.findUserEmail(pool, document.version_uploaded_by ?? document.uploaded_by),
      ]);
      return {
        document,
        current: {
          version: document.version,
          filename: document.filename,
          size: Number(document.size),
          sha256: document.sha256,
          scanStatus: document.scan_status,
          uploadedBy: document.version_uploaded_by ?? document.uploaded_by,
          uploadedByEmail: uploader ?? '',
          createdAt: document.version_created_at ?? document.created_at,
        },
        history,
      };
    },

    /** A signed URL for one earlier version (the current one goes through getDownloadUrl). */
    async getVersionDownloadUrl(documentId: string, version: number, userId: string): Promise<string> {
      const { document } = await authorizeById(documentId, userId);
      if (version === document.version) return service.getDownloadUrl(documentId, userId);
      const row = await versionsRepo.find(pool, document.id, version);
      if (!row) throw Errors.notFound('Version');
      assertScanAllows(row);
      audit.recordAsync({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.downloaded',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { filename: row.filename, version },
      });
      return storage.getSignedUrl(row.storage_key, opts.signedUrlTtlSeconds, {
        filename: row.filename,
        contentType: row.mime_type,
      });
    },

    /**
     * Brings back an earlier version by copying its bytes into a new current version, so the
     * history is never rewritten and every version keeps its own object.
     */
    async restoreVersion(documentId: string, version: number, userId: string): Promise<DocumentRow> {
      const document = await authorizeContentChange(documentId, userId);
      if (version === document.version)
        throw Errors.conflict('ALREADY_CURRENT', 'That is already the current version.');
      const row = await versionsRepo.find(pool, document.id, version);
      if (!row) throw Errors.notFound('Version');
      assertScanAllows(row);
      if (document.scan_status === 'pending') {
        throw Errors.conflict(
          'SCAN_PENDING',
          'The current version is still being checked for malware. Try again in a moment.',
        );
      }
      const usage = await workspacesRepo.storageUsage(pool, document.workspace_id);
      if (usage.usedBytes + Number(row.size) > usage.quotaBytes) {
        throw Errors.quotaExceeded(usage.usedBytes, usage.quotaBytes);
      }

      const storageKey = documentVersionObjectKey(document.workspace_id, document.id, randomUUID());
      if (storage.copy) {
        await storage.copy(row.storage_key, storageKey);
      } else if (Number(row.size) <= opts.maxUploadBytes) {
        // A store without its own copy: the bytes pass through here, so only as much as an upload.
        await storage.upload(storageKey, await storage.download(row.storage_key), row.mime_type);
      } else {
        throw Errors.payloadTooLarge(opts.maxUploadBytes);
      }
      return replaceCurrent({
        document,
        userId,
        storageKey,
        size: Number(row.size),
        sha256: row.sha256,
        scanStatus: row.scan_status,
        audit: { action: 'document.version_restored', metadata: { restoredFrom: version } },
      });
    },

    /** Deletes one earlier version for good. The current version can only go to the trash. */
    async deleteVersion(documentId: string, version: number, userId: string): Promise<void> {
      const document = await authorizeContentChange(documentId, userId);
      if (version === document.version) {
        throw Errors.conflict(
          'CURRENT_VERSION',
          'The current version cannot be deleted on its own. Restore another version first, or move the document to the trash.',
        );
      }
      const row = await versionsRepo.find(pool, document.id, version);
      if (!row) throw Errors.notFound('Version');
      await removeVersion(row);
      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: userId,
        action: 'document.version_deleted',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { filename: row.filename, version },
      });
    },

    /**
     * Worker: derives a thumbnail, search text and (for Office files, when a converter is set) a
     * PDF preview from a document's current version. Only files the scan has cleared are read.
     * A file that can't be parsed is recorded as failed, not retried; storage and database errors
     * throw so the job retries. If a new version arrives meanwhile, the work is thrown away and
     * done again for it.
     */
    async processDocument(documentId: string): Promise<void> {
      for (let round = 0; round < 3; round += 1) {
        const row = await documentsRepo.findAnyById(pool, documentId);
        if (!row || row.processed_key === row.storage_key) return;
        if (row.scan_status === 'pending') return; // the scan queues this again when it clears the file
        const now = clock.now();
        if (row.scan_status === 'infected' || Number(row.size) > opts.processingMaxBytes) {
          await documentsRepo.setProcessed(pool, row.id, row.storage_key, {
            thumbnailKey: null,
            previewKey: null,
            status: 'skipped',
            at: now,
          });
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of await storage.download(row.storage_key)) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        let failed = false;
        const attempt = async <T>(what: string, work: () => Promise<T>): Promise<T | null> => {
          try {
            return await work();
          } catch (error) {
            failed = true;
            logger.warn({ err: error, documentId, what }, 'could not process a document');
            return null;
          }
        };

        const converter = opts.officeConverter;
        const preview =
          converter && OFFICE_TYPES.has(row.mime_type)
            ? await attempt('office preview', () =>
                converter.toPdf(`document.${officeExtension(row.mime_type) ?? 'bin'}`, body),
              )
            : null;
        const text =
          (await attempt('text', () => extractText(row.mime_type, body))) ??
          (preview ? await attempt('preview text', () => extractText('application/pdf', preview)) : null);
        const thumbnail =
          (await attempt('thumbnail', () => makeThumbnail(row.mime_type, body))) ??
          (preview ? await attempt('preview thumbnail', () => makeThumbnail('application/pdf', preview)) : null);

        const thumbnailKey = thumbnail ? derivedObjectKey(row.workspace_id, row.id, 'webp') : null;
        const previewKey = preview ? derivedObjectKey(row.workspace_id, row.id, 'pdf') : null;
        if (thumbnail) await storage.upload(thumbnailKey!, Readable.from(thumbnail), 'image/webp');
        if (preview) await storage.upload(previewKey!, Readable.from(preview), 'application/pdf');

        const outcome = await withTransaction(pool, async (tx) => {
          const current = await documentsRepo.lockAny(tx, row.id);
          if (!current || current.storage_key !== row.storage_key) return null;
          await documentsRepo.setProcessed(tx, row.id, row.storage_key, {
            thumbnailKey,
            previewKey,
            status: failed ? 'failed' : 'done',
            at: now,
          });
          if (text) {
            await documentsRepo.saveContents(tx, {
              documentId: row.id,
              workspaceId: row.workspace_id,
              storageKey: row.storage_key,
              body: text,
            });
          } else {
            await documentsRepo.deleteContents(tx, row.id);
          }
          return { replaced: [current.thumbnail_key, current.preview_key] };
        });
        if (outcome) {
          deleteQuietly(outcome.replaced.filter((key) => key !== thumbnailKey && key !== previewKey));
          return;
        }
        // A new version arrived while this one was being read: discard, and go again.
        deleteQuietly([thumbnailKey, previewKey]);
      }
    },

    /** Maintenance: queues processing for documents that were cleared but never processed. */
    async enqueuePendingProcessing(limit = 100): Promise<number> {
      const rows = await documentsRepo.pendingProcessing(pool, limit);
      for (const row of rows) await enqueueProcessing(pool, row.id);
      return rows.length;
    },

    /** A document's thumbnail, for any member of its workspace; null when it has none (yet). */
    async thumbnail(documentId: string, userId: string) {
      const { document } = await authorizeById(documentId, userId);
      if (!document.thumbnail_key || document.processed_key !== document.storage_key) return null;
      return storage.download(document.thumbnail_key);
    },

    /** A document's comment thread, oldest first, for any member of its workspace. */
    async listComments(documentId: string, userId: string): Promise<{ comments: CommentRow[]; role: Role }> {
      const { document, role } = await authorizeById(documentId, userId);
      return { comments: await commentsRepo.list(pool, document.id, MAX_COMMENTS), role };
    },

    /**
     * Adds a comment. Any member may comment, viewers included. The uploader and everyone else
     * in the thread are notified; the comment and its audit entry are written together.
     */
    async addComment(documentId: string, userId: string, body: string): Promise<{ comment: CommentRow; role: Role }> {
      const { document, role } = await authorizeById(documentId, userId);
      const text = cleanCommentBody(body);
      if ((await commentsRepo.count(pool, document.id)) >= MAX_COMMENTS) {
        throw Errors.conflict('TOO_MANY_COMMENTS', `A document can have at most ${MAX_COMMENTS} comments.`);
      }
      const id = randomUUID();
      await withTransaction(pool, async (tx) => {
        await commentsRepo.insert(tx, {
          id,
          documentId: document.id,
          workspaceId: document.workspace_id,
          authorId: userId,
          body: text,
          at: clock.now(),
        });
        await audit.record(
          {
            workspaceId: document.workspace_id,
            actorUserId: userId,
            action: 'document.comment_added',
            resourceType: 'document',
            resourceId: document.id,
            metadata: { filename: document.filename, commentId: id },
          },
          tx,
        );
      });
      const comment = await commentsRepo.find(pool, document.id, id);
      if (!comment) throw Errors.notFound('Comment');
      const recipients = await commentsRepo.participants(pool, document.id, document.workspace_id, userId);
      notifications.notifyUsers(recipients, {
        workspaceId: document.workspace_id,
        type: 'document.commented',
        title: `${comment.author_email} commented on ${document.filename}`,
        body: text.length > 140 ? `${text.slice(0, 139)}…` : text,
        resourceId: document.id,
      });
      return { comment, role };
    },

    /** Edits a comment. Only its author can, whatever their role. */
    async editComment(
      documentId: string,
      commentId: string,
      userId: string,
      body: string,
    ): Promise<{ comment: CommentRow; role: Role }> {
      const { document, role } = await authorizeById(documentId, userId);
      const existing = await commentsRepo.find(pool, document.id, commentId);
      if (!existing) throw Errors.notFound('Comment');
      if (existing.author_id !== userId) throw Errors.forbidden('Only the person who wrote a comment can edit it.');
      await commentsRepo.update(pool, existing.id, cleanCommentBody(body), clock.now());
      const comment = await commentsRepo.find(pool, document.id, commentId);
      if (!comment) throw Errors.notFound('Comment');
      return { comment, role };
    },

    /** Deletes a comment: its author, or a workspace owner. */
    async deleteComment(documentId: string, commentId: string, userId: string): Promise<void> {
      const { document, role } = await authorizeById(documentId, userId);
      const existing = await commentsRepo.find(pool, document.id, commentId);
      if (!existing) throw Errors.notFound('Comment');
      if (!Permissions.canDeleteComment(role, existing.author_id, userId)) {
        throw Errors.forbidden("Only the comment's author or a workspace owner can delete it.");
      }
      await withTransaction(pool, async (tx) => {
        await commentsRepo.remove(tx, existing.id);
        await audit.record(
          {
            workspaceId: document.workspace_id,
            actorUserId: userId,
            action: 'document.comment_deleted',
            resourceType: 'document',
            resourceId: document.id,
            metadata: { filename: document.filename, commentId: existing.id, authorEmail: existing.author_email },
          },
          tx,
        );
      });
    },

    async setStar(documentId: string, userId: string, starred: boolean): Promise<void> {
      await authorizeById(documentId, userId);
      await documentsRepo.setStar(pool, userId, documentId, starred);
    },

    /**
     * Job handler for document.scan: streams the object to the scanner. Clean files become
     * available; infected ones are quarantined. If the scanner is unreachable this throws and the
     * job retries with backoff; the file stays blocked meanwhile (fail closed).
     */
    async scanDocument(documentId: string): Promise<void> {
      const row = await documentsRepo.findAnyById(pool, documentId);
      if (!row) return;
      if (row.scan_status === 'infected') {
        // A previous attempt quarantined it but couldn't delete the bytes: finish that.
        await storage.delete(row.storage_key);
        return;
      }
      if (row.scan_status !== 'pending') return;
      if (!opts.scanner) throw new Error('scanning is pending but no scanner is configured');

      const result = await opts.scanner.scan(await storage.download(row.storage_key));
      const now = clock.now();
      if (!result.infected) {
        if (await documentsRepo.setScanResult(pool, row.id, row.storage_key, 'clean', null, now)) {
          await enqueueProcessing(pool, row.id);
        }
        return;
      }

      const quarantined = await withTransaction(pool, async (tx) => {
        if (!(await documentsRepo.setScanResult(tx, row.id, row.storage_key, 'infected', result.signature, now))) {
          return false;
        }
        const revoked = await sharesRepo.revokeForDocument(tx, row.id, now);
        await workspacesRepo.releaseStorage(tx, row.workspace_id, Number(row.size));
        await audit.record(
          {
            workspaceId: row.workspace_id,
            actorUserId: null,
            action: 'document.quarantined',
            resourceType: 'document',
            resourceId: row.id,
            metadata: { filename: row.filename, signature: result.signature, revokedLinks: revoked },
          },
          tx,
        );
        return true;
      });
      if (!quarantined) return;
      notifications.notify({
        userId: row.uploaded_by,
        workspaceId: row.workspace_id,
        type: 'document.quarantined',
        title: `${row.filename} was removed: malware was found`,
        body: `The scanner identified ${result.signature}. The file can't be downloaded or shared.`,
        resourceId: row.id,
      });
      logger.warn({ documentId: row.id, signature: result.signature }, 'quarantined an infected upload');
      // After the commit: if this fails the job retries and the branch at the top finishes it.
      await storage.delete(row.storage_key);
    },

    /** Maintenance: re-queues scans for files still pending after their job gave up. */
    async requeuePendingScans(limit = 100): Promise<number> {
      const stale = await documentsRepo.pendingWithoutScanJob(pool, 10, limit);
      for (const { id } of stale) {
        await jobs.enqueue(pool, 'document.scan', { documentId: id }, { dedupeKey: id, maxAttempts: 8 });
      }
      return stale.length;
    },

    async storageUsage(workspaceId: string) {
      return workspacesRepo.storageUsage(pool, workspaceId);
    },

    /** Cleanup job: purges trash past retention. One failure never stops the rest. */
    async purgeExpiredTrash(batchSize = 100): Promise<{ purged: number; failed: number }> {
      const cutoff = new Date(clock.now().getTime() - opts.trashRetentionDays * 86_400_000);
      const expired = await documentsRepo.expiredTrash(pool, cutoff, batchSize);
      let purged = 0;
      let failed = 0;
      for (const document of expired) {
        try {
          await deleteVersionObjects(document.id);
          await storage.delete(document.storage_key);
          await deleteTrashedRow(document.id);
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
  return service;
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
