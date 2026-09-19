import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/tokens';
import { Permissions, requireContributor } from '../../policy';
import type { Clock, Role } from '../../types';
import type { AuditService } from '../audit/audit.service';
import type { DocumentsService } from '../documents/documents.service';
import { foldersRepo } from '../folders/folders.repo';
import type { NotificationsService } from '../notifications/notifications.service';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import { fileRequestsRepo, type FileRequestRow, type ResolvedFileRequest } from './file-requests.repo';

export interface FileRequestsServiceOptions {
  pool: Pool;
  clock: Clock;
  webUrl: string;
  maxUploadBytes: number;
  audit: AuditService;
  notifications: NotificationsService;
  documents: DocumentsService;
}

const LIST_LIMIT = 200;
const RECEIVED_LIMIT = 500;
const DAY_MS = 86_400_000;

export type FileRequestStatus = 'open' | 'full' | 'expired' | 'revoked';

export function fileRequestStatus(row: FileRequestRow, now: Date): FileRequestStatus {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at <= now) return 'expired';
  if (row.max_files !== null && row.received_count >= row.max_files) return 'full';
  return 'open';
}

/**
 * File requests: links through which someone outside the workspace uploads files into it.
 *
 * Making one is a contributor's right, like sharing (a viewer can't bring files in). The link
 * works only while its maker can still upload there: removing them or making them a viewer
 * revokes it, in the same transaction as their share links. Files go through exactly the same
 * upload path as a member's (type check against the bytes, size limit, quota, malware scan).
 */
export function createFileRequestsService(opts: FileRequestsServiceOptions) {
  const { pool, clock, audit, notifications, documents } = opts;

  async function requireContributorIn(workspaceId: string, userId: string, action: string): Promise<Role> {
    const role = await workspacesRepo.findMembership(pool, workspaceId, userId);
    if (!role) throw Errors.notFound('Workspace');
    requireContributor(role, action);
    return role;
  }

  async function requireManageable(requestId: string, userId: string) {
    const request = await fileRequestsRepo.findById(pool, requestId);
    if (!request) throw Errors.notFound('File request');
    const role = await workspacesRepo.findMembership(pool, request.workspace_id, userId);
    if (!role) throw Errors.notFound('File request');
    requireContributor(role, 'see file requests');
    return { request, role };
  }

  /** A request still taking files, or 404 (never existed) / 410 (revoked, expired, full, workspace gone). */
  async function resolveOrThrow(token: string): Promise<ResolvedFileRequest> {
    const tokenHash = hashToken(token);
    const request = await fileRequestsRepo.resolveLive(pool, tokenHash, clock.now());
    if (request) return request;
    if (await fileRequestsRepo.exists(pool, tokenHash)) {
      throw Errors.gone('This file request has been closed. Ask the person who sent it for a new link.');
    }
    throw Errors.notFound('File request');
  }

  const remaining = (row: FileRequestRow) =>
    row.max_files === null ? null : Math.max(0, row.max_files - row.received_count);

  return {
    async create(
      userId: string,
      workspaceId: string,
      input: {
        title: string;
        message?: string | null;
        folderId?: string | null;
        expiresInDays: number;
        maxFiles?: number | null;
      },
    ) {
      const role = await requireContributorIn(workspaceId, userId, 'request files');
      const folderId = input.folderId ?? null;
      if (folderId && !(await foldersRepo.findInWorkspace(pool, workspaceId, folderId))) {
        throw Errors.notFound('Folder');
      }
      const token = generateToken('frq');
      const id = randomUUID();
      const now = clock.now();
      await withTransaction(pool, async (tx) => {
        await fileRequestsRepo.insert(tx, {
          id,
          workspaceId,
          folderId,
          createdBy: userId,
          tokenHash: hashToken(token),
          title: input.title,
          message: input.message || null,
          maxFiles: input.maxFiles ?? null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS),
        });
        await audit.record(
          {
            workspaceId,
            actorUserId: userId,
            action: 'file_request.created',
            resourceType: 'file_request',
            resourceId: id,
            metadata: { title: input.title, expiresInDays: input.expiresInDays, maxFiles: input.maxFiles ?? null },
          },
          tx,
        );
      });
      const request = await fileRequestsRepo.findById(pool, id);
      if (!request) throw Errors.notFound('File request');
      return { request, role, url: `${opts.webUrl}/r/${token}` };
    },

    async list(userId: string, workspaceId: string) {
      const role = await requireContributorIn(workspaceId, userId, 'see file requests');
      return { requests: await fileRequestsRepo.listForWorkspace(pool, workspaceId, LIST_LIMIT), role };
    },

    async received(requestId: string, userId: string) {
      const { request } = await requireManageable(requestId, userId);
      return fileRequestsRepo.received(pool, request.id, RECEIVED_LIMIT);
    },

    /** Closes a request: its maker, or a workspace owner. Files already received stay. */
    async revoke(requestId: string, userId: string): Promise<void> {
      const { request, role } = await requireManageable(requestId, userId);
      if (!Permissions.canManageShare(role, request.created_by, userId)) {
        throw Errors.forbidden('Only the person who made the request or a workspace owner can close it.');
      }
      if (request.revoked_at) return;
      await withTransaction(pool, async (tx) => {
        await fileRequestsRepo.revoke(tx, request.id, clock.now());
        await audit.record(
          {
            workspaceId: request.workspace_id,
            actorUserId: userId,
            action: 'file_request.revoked',
            resourceType: 'file_request',
            resourceId: request.id,
            metadata: { title: request.title, received: request.received_count },
          },
          tx,
        );
      });
    },

    /** What the link's holder sees before uploading. */
    async publicInfo(token: string) {
      const request = await resolveOrThrow(token);
      if (remaining(request) === 0) {
        throw Errors.gone('This file request has all the files it asked for.');
      }
      return {
        title: request.title,
        message: request.message,
        requestedBy: request.creator_email,
        workspaceName: request.workspace_name,
        expiresAt: request.expires_at,
        remainingFiles: remaining(request),
        maxFileBytes: opts.maxUploadBytes,
      };
    },

    /** One file from the link's holder. Stored as the request's maker; the sender is recorded beside it. */
    async publicUpload(
      token: string,
      input: {
        senderName: string;
        senderEmail: string | null;
        filename: string;
        declaredMimeType: string;
        body: Buffer;
        truncated: boolean;
      },
    ) {
      const request = await resolveOrThrow(token);
      const role = await workspacesRepo.findMembership(pool, request.workspace_id, request.created_by);
      // Defence in depth: losing upload rights revokes the request, but never trust that alone.
      if (!role || role === 'VIEWER') throw Errors.gone();
      const { document } = await documents.upload({
        membership: { workspaceId: request.workspace_id, role },
        userId: request.created_by,
        userEmail: request.creator_email,
        folderId: request.folder_id,
        filename: input.filename,
        declaredMimeType: input.declaredMimeType,
        body: input.body,
        truncated: input.truncated,
        fileRequest: {
          id: request.id,
          title: request.title,
          senderName: input.senderName,
          senderEmail: input.senderEmail,
        },
      });
      notifications.notify({
        userId: request.created_by,
        workspaceId: request.workspace_id,
        type: 'file_request.received',
        title: `${input.senderName} sent ${document.filename}`,
        body: `Through your file request “${request.title}”.`,
        resourceId: document.id,
      });
      const latest = await fileRequestsRepo.findById(pool, request.id);
      return {
        file: { filename: document.filename, size: Number(document.size) },
        remainingFiles: latest ? remaining(latest) : null,
      };
    },
  };
}

export type FileRequestsService = ReturnType<typeof createFileRequestsService>;
