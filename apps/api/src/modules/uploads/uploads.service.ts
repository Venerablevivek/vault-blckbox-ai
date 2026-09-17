import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/tx';
import type { JobQueue } from '../../jobs/queue';
import { AppError, Errors } from '../../lib/errors';
import { ALLOWED_MIME_TYPES, assertAllowedType } from '../../lib/mime';
import { requireContributor } from '../../policy';
import { documentObjectKey } from '../../storage/keys';
import type { FileStorage } from '../../storage/file-storage';
import type { MultipartStorage } from '../../storage/multipart-storage';
import type { Clock, Membership } from '../../types';
import type { AuditService } from '../audit/audit.service';
import { cleanFilename } from '../documents/documents.service';
import { documentsRepo, type DocumentRow } from '../documents/documents.repo';
import { foldersRepo } from '../folders/folders.repo';
import type { NotificationsService } from '../notifications/notifications.service';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import { uploadsRepo, type UploadRow } from './uploads.repo';

const MiB = 1024 * 1024;
/** S3 requires every part but the last to be at least 5 MiB; 8 MiB keeps part counts low. */
export const MIN_PART_SIZE = 8 * MiB;
export const MAX_PARTS = 10_000;
/** Enough of the file to recognise its type from its first bytes. */
const SNIFF_BYTES = 4096;

/** Part size and count for a file: 8 MiB parts, growing only if the file would need more than 10,000. */
export function planParts(size: number): { partSize: number; partCount: number } {
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

export function toUploadDto(row: UploadRow) {
  return {
    id: row.id,
    filename: row.filename,
    size: Number(row.size),
    folderId: row.folder_id,
    partSize: row.part_size,
    partCount: row.part_count,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export interface UploadsServiceOptions {
  pool: Pool;
  storage: FileStorage & MultipartStorage;
  clock: Clock;
  logger: Logger;
  audit: AuditService;
  notifications: NotificationsService;
  jobs: JobQueue;
  maxDirectUploadBytes: number;
  sessionTtlHours: number;
  partUrlTtlSeconds: number;
}

export function createUploadsService(opts: UploadsServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications, jobs } = opts;

  /**
   * An upload belongs to the person who started it, and they must still be able to upload to its
   * workspace. Anyone else gets 404, like any resource outside their reach.
   */
  async function authorize(uploadId: string, userId: string): Promise<UploadRow> {
    const upload = await uploadsRepo.findById(pool, uploadId);
    if (!upload || upload.created_by !== userId) throw Errors.notFound('Upload');
    const role = await workspacesRepo.findMembership(pool, upload.workspace_id, userId);
    if (!role) throw Errors.notFound('Upload');
    requireContributor(role, 'upload documents');
    return upload;
  }

  function requirePending(upload: UploadRow): void {
    if (upload.status !== 'pending') {
      throw Errors.conflict('UPLOAD_NOT_PENDING', `This upload is ${upload.status} and can't be changed.`);
    }
  }

  /** Removes whatever storage holds for an upload: the in-progress parts and any completed object. */
  async function discardStorage(upload: UploadRow): Promise<void> {
    await storage.abortMultipartUpload(upload.storage_key, upload.storage_upload_id);
    if (await storage.headObject(upload.storage_key)) await storage.delete(upload.storage_key);
  }

  /** Ends an upload in `status`, discarding its bytes and returning its reserved quota. */
  async function finish(upload: UploadRow, from: UploadRow['status'][], status: 'aborted' | 'expired' | 'rejected') {
    await discardStorage(upload);
    return withTransaction(pool, async (tx) => {
      const moved = await uploadsRepo.transition(tx, upload.id, from, status, clock.now());
      if (moved) await workspacesRepo.releaseStorage(tx, upload.workspace_id, Number(upload.size));
      return moved;
    });
  }

  return {
    /**
     * Opens an upload: validates the request, reserves quota for the whole file, and starts a
     * multipart upload in storage. The quota is reserved now, not on completion, so several large
     * uploads started together cannot overrun the workspace between them.
     */
    async create(input: {
      membership: Membership;
      userId: string;
      filename: string;
      size: number;
      mimeType: string;
      folderId: string | null;
    }) {
      requireContributor(input.membership.role, 'upload documents');
      const { workspaceId } = input.membership;
      if (input.size <= 0) throw Errors.badRequest('EMPTY_FILE', 'The file is empty.');
      if (input.size > opts.maxDirectUploadBytes) throw Errors.payloadTooLarge(opts.maxDirectUploadBytes);

      const declaredMime = input.mimeType.split(';')[0]!.trim().toLowerCase();
      // The declared type is checked now for a quick answer; the real bytes are checked on completion.
      if (!ALLOWED_MIME_TYPES.has(declaredMime)) {
        throw Errors.unsupportedMediaType(`File type "${declaredMime || 'unknown'}" is not allowed.`);
      }
      const filename = cleanFilename(input.filename);
      if (input.folderId && !(await foldersRepo.findInWorkspace(pool, workspaceId, input.folderId))) {
        throw Errors.notFound('Folder');
      }

      const usage = await workspacesRepo.storageUsage(pool, workspaceId);
      if (usage.usedBytes + input.size > usage.quotaBytes)
        throw Errors.quotaExceeded(usage.usedBytes, usage.quotaBytes);

      const { partSize, partCount } = planParts(input.size);
      const documentId = randomUUID();
      const storageKey = documentObjectKey(workspaceId, documentId);
      const storageUploadId = await storage.createMultipartUpload(storageKey, declaredMime);

      try {
        const now = clock.now();
        return await withTransaction(pool, async (tx) => {
          if (!(await workspacesRepo.reserveStorage(tx, workspaceId, input.size))) {
            const latest = await workspacesRepo.storageUsage(tx, workspaceId);
            throw Errors.quotaExceeded(latest.usedBytes, latest.quotaBytes);
          }
          return uploadsRepo.insert(tx, {
            id: randomUUID(),
            workspaceId,
            folderId: input.folderId,
            createdBy: input.userId,
            documentId,
            filename,
            declaredMime,
            size: input.size,
            partSize,
            partCount,
            storageKey,
            storageUploadId,
            now,
            expiresAt: new Date(now.getTime() + opts.sessionTtlHours * 3_600_000),
          });
        });
      } catch (error) {
        await storage.abortMultipartUpload(storageKey, storageUploadId).catch((abortError: unknown) => {
          logger.error({ err: abortError, storageKey }, 'failed to abort multipart upload after a failed create');
        });
        throw error;
      }
    },

    /** Signed URLs for the given parts. Each URL accepts one PUT of that part, for a limited time. */
    async signParts(uploadId: string, userId: string, partNumbers: number[]) {
      const upload = await authorize(uploadId, userId);
      requirePending(upload);
      const invalid = partNumbers.filter((n) => n < 1 || n > upload.part_count);
      if (invalid.length > 0) {
        throw Errors.badRequest('INVALID_PART', `This upload has parts 1 to ${upload.part_count}.`);
      }
      const expiresAt = new Date(clock.now().getTime() + opts.partUrlTtlSeconds * 1000);
      const parts = await Promise.all(
        [...new Set(partNumbers)].map(async (partNumber) => ({
          partNumber,
          url: await storage.signUploadPart(
            upload.storage_key,
            upload.storage_upload_id,
            partNumber,
            opts.partUrlTtlSeconds,
          ),
        })),
      );
      return { parts, expiresAt };
    },

    /** The upload and the parts storage has received, so a client can resume where it stopped. */
    async get(uploadId: string, userId: string) {
      const upload = await authorize(uploadId, userId);
      const uploadedParts =
        upload.status === 'pending'
          ? (await storage.listParts(upload.storage_key, upload.storage_upload_id)).map((p) => ({
              partNumber: p.partNumber,
              size: p.size,
            }))
          : [];
      return { upload, uploadedParts };
    },

    async abort(uploadId: string, userId: string): Promise<void> {
      const upload = await authorize(uploadId, userId);
      requirePending(upload);
      if (!(await finish(upload, ['pending'], 'aborted'))) {
        throw Errors.conflict('UPLOAD_NOT_PENDING', 'This upload is no longer in progress.');
      }
    },

    /**
     * Completes an upload and creates the document.
     *
     * Storage's own record of the parts is the source of truth, not the client: every part must be
     * present and exactly the planned size. The assembled object's size is checked, and its first
     * bytes must match an allowed type, exactly like an upload through the API. A file that fails
     * a check is deleted and its quota returned. A check that fails because parts are still
     * missing leaves the upload open, so the client can send them and try again.
     */
    async complete(uploadId: string, user: { id: string; email: string }): Promise<{ document: DocumentRow }> {
      const current = await authorize(uploadId, user.id);
      if (current.status === 'completed') {
        const existing = await documentsRepo.findAnyById(pool, current.document_id);
        if (existing) return { document: existing };
      }

      const upload = await uploadsRepo.transition(pool, uploadId, ['pending'], 'completing', clock.now());
      if (!upload) throw Errors.conflict('UPLOAD_NOT_PENDING', `This upload is ${current.status}.`);

      const size = Number(upload.size);
      try {
        if (!(await storage.headObject(upload.storage_key))) {
          const parts = await storage.listParts(upload.storage_key, upload.storage_upload_id);
          const missing: number[] = [];
          for (let n = 1; n <= upload.part_count; n++) if (!parts.some((p) => p.partNumber === n)) missing.push(n);
          if (missing.length > 0) {
            throw new AppError(409, 'UPLOAD_INCOMPLETE', `Parts still missing: ${missing.slice(0, 20).join(', ')}.`);
          }
          const lastSize = size - upload.part_size * (upload.part_count - 1);
          const wrong = parts.find(
            (p) =>
              p.partNumber > upload.part_count ||
              p.size !== (p.partNumber === upload.part_count ? lastSize : upload.part_size),
          );
          if (wrong)
            throw new RejectUpload(
              Errors.badRequest('UPLOAD_SIZE_MISMATCH', 'The uploaded parts do not add up to the declared file size.'),
            );
          await storage.completeMultipartUpload(upload.storage_key, upload.storage_upload_id, parts);
        }

        const stored = await storage.headObject(upload.storage_key);
        if (!stored || stored.size !== size) {
          throw new RejectUpload(
            Errors.badRequest('UPLOAD_SIZE_MISMATCH', 'The stored file does not match the declared size.'),
          );
        }

        let mimeType: string;
        try {
          mimeType = assertAllowedType(
            upload.declared_mime,
            await storage.readRange(upload.storage_key, 0, Math.min(size, SNIFF_BYTES) - 1),
          );
        } catch (error) {
          throw new RejectUpload(error as AppError);
        }

        const document = await withTransaction(pool, async (tx) => {
          // The destination folder may have been deleted while the file was uploading.
          const folderId =
            upload.folder_id && (await foldersRepo.findInWorkspace(tx, upload.workspace_id, upload.folder_id))
              ? upload.folder_id
              : null;
          const row = await documentsRepo.insert(tx, {
            id: upload.document_id,
            workspaceId: upload.workspace_id,
            folderId,
            uploadedBy: user.id,
            filename: upload.filename,
            storageKey: upload.storage_key,
            mimeType,
            size,
            sha256: null,
          });
          await audit.record(
            {
              workspaceId: upload.workspace_id,
              actorUserId: user.id,
              action: 'document.uploaded',
              resourceType: 'document',
              resourceId: row.id,
              metadata: { filename: row.filename, size, direct: true },
            },
            tx,
          );
          await notifications.notifyWorkspace(tx, upload.workspace_id, user.id, {
            type: 'document.uploaded',
            title: `${row.filename} was added`,
            body: `${user.email} uploaded a new document to this workspace.`,
            resourceId: row.id,
          });
          // Hashing a multi-gigabyte object is work for the worker, not the request.
          await jobs.enqueue(tx, 'document.checksum', { documentId: row.id }, { dedupeKey: row.id });
          await uploadsRepo.transition(tx, upload.id, ['completing'], 'completed', clock.now());
          return row;
        });
        return { document };
      } catch (error) {
        if (error instanceof RejectUpload) {
          await finish(upload, ['completing'], 'rejected').catch((cleanupError: unknown) => {
            logger.error({ err: cleanupError, uploadId }, 'failed to clean up a rejected upload; it will expire');
          });
          throw error.reason;
        }
        // Anything else (missing parts, a storage or database hiccup) leaves the upload open for a retry.
        await uploadsRepo.transition(pool, upload.id, ['completing'], 'pending', clock.now());
        throw error;
      }
    },

    /** Maintenance: closes uploads left open past their expiry and returns their quota. */
    async expireStale(limit = 100): Promise<{ expired: number; failed: number }> {
      let expired = 0;
      let failed = 0;
      for (const upload of await uploadsRepo.expired(pool, clock.now(), limit)) {
        try {
          if (await finish(upload, ['pending', 'completing'], 'expired')) expired += 1;
        } catch (error) {
          failed += 1;
          logger.error({ err: error, uploadId: upload.id }, 'failed to expire upload; will retry next run');
        }
      }
      return { expired, failed };
    },
  };
}

/** A completed upload failed verification: its object is deleted and its quota released. */
class RejectUpload extends Error {
  constructor(readonly reason: AppError) {
    super(reason.message);
  }
}

export type UploadsService = ReturnType<typeof createUploadsService>;
