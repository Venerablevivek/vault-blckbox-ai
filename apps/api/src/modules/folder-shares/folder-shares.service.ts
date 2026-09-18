import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { Errors } from '../../lib/errors';
import { generateToken, hashToken } from '../../lib/tokens';
import { Permissions, requireContributor } from '../../policy';
import type { FileStorage } from '../../storage/file-storage';
import type { Clock } from '../../types';
import type { AuditService } from '../audit/audit.service';
import { hashPassword, verifyPassword } from '../auth/password';
import { planArchive, type ArchivePlan } from '../documents/archive';
import { documentsRepo } from '../documents/documents.repo';
import { assertScanAllows } from '../documents/scan-policy';
import { foldersRepo } from '../folders/folders.repo';
import type { NotificationsService } from '../notifications/notifications.service';
import { isBot, LINK_LOCKOUT_WINDOW_MS, LINK_PASSWORD_ATTEMPTS, type Visitor } from '../shares/shares.service';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import {
  FOLDER_LISTING_LIMIT,
  folderSharesRepo,
  type FolderShareRow,
  type ResolvedFolderShare,
} from './folder-shares.repo';

export interface FolderSharesServiceOptions {
  pool: Pool;
  storage: FileStorage;
  clock: Clock;
  logger: Logger;
  webUrl: string;
  defaultTtlHours: number;
  signedUrlTtlSeconds: number;
  grantSecret: string;
  archiveMaxFiles: number;
  archiveMaxBytes: number;
  audit: AuditService;
  notifications: NotificationsService;
}

/** How long an unlocked folder link stays unlocked in that browser. */
export const FOLDER_GRANT_TTL_SECONDS = 60 * 60;

/** The cookie holding the unlock grant for one folder link, named after the token's hash. */
export function folderGrantCookieName(token: string): string {
  return `fg_${hashToken(token).toString('hex').slice(0, 16)}`;
}

export function createFolderSharesService(opts: FolderSharesServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications } = opts;

  /** `<expiry>.<hmac>` over the link id, the expiry and the current password hash, like document links. */
  function signGrant(share: FolderShareRow, expiresAt: number): string {
    const mac = createHmac('sha256', opts.grantSecret)
      .update(`folder.${share.id}.${expiresAt}.${share.password_hash}`)
      .digest('base64url');
    return `${expiresAt}.${mac}`;
  }

  function unlocked(share: FolderShareRow, grant: string | undefined): boolean {
    if (!share.password_hash) return true;
    if (!grant) return false;
    const expiresAt = Number(grant.split('.')[0]);
    if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(clock.now().getTime() / 1000)) return false;
    const expected = Buffer.from(signGrant(share, expiresAt));
    const actual = Buffer.from(grant);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** A usable link, or 404 (never existed) / 410 (revoked, expired, or its workspace deleted). */
  async function resolveOrThrow(token: string): Promise<ResolvedFolderShare> {
    const tokenHash = hashToken(token);
    const share = await folderSharesRepo.resolveLive(pool, tokenHash, clock.now());
    if (share) return share;
    if (await folderSharesRepo.exists(pool, tokenHash)) throw Errors.gone();
    throw Errors.notFound('Link');
  }

  async function requireUnlocked(token: string, grant: string | undefined): Promise<ResolvedFolderShare> {
    const share = await resolveOrThrow(token);
    if (!unlocked(share, grant)) {
      throw Errors.credentialRequired('PASSWORD_REQUIRED', 'This link is protected by a password.');
    }
    return share;
  }

  /** The folder to show: the shared one, or one below it. Anything else is 404. */
  async function folderWithin(share: ResolvedFolderShare, folderId: string | undefined) {
    const path = await folderSharesRepo.pathWithin(pool, share.folder_id, folderId ?? share.folder_id);
    if (!path) throw Errors.notFound('Folder');
    return path;
  }

  async function requireManageable(shareId: string, userId: string) {
    const share = await folderSharesRepo.findById(pool, shareId);
    if (!share) throw Errors.notFound('Link');
    const role = await workspacesRepo.findMembership(pool, share.workspace_id, userId);
    if (!role) throw Errors.notFound('Link');
    if (!Permissions.canManageShare(role, share.created_by, userId)) {
      throw Errors.forbidden('Only the link creator or a workspace owner can change it.');
    }
    return share;
  }

  /** Counts an access; on the very first open, tells the person who made the link. */
  function recordAccess(share: ResolvedFolderShare, kind: 'open' | 'download', filename?: string): void {
    void (async () => {
      const opens = await folderSharesRepo.countAccess(pool, share.id, kind, clock.now());
      audit.recordAsync({
        workspaceId: share.workspace_id,
        actorUserId: null,
        action: 'share.accessed',
        resourceType: 'folder_share',
        resourceId: share.id,
        metadata: { filename: filename ?? `${share.folder_name}/`, folder: share.folder_name, outcome: kind },
      });
      if (kind !== 'open' || opens !== 1) return;
      if (!(await workspacesRepo.findMembership(pool, share.workspace_id, share.created_by))) return;
      notifications.notify({
        userId: share.created_by,
        workspaceId: share.workspace_id,
        type: 'share.first_open',
        title: `Your link to the folder ${share.folder_name} was opened`,
        body: 'This is the first time anyone has opened it.',
        resourceId: null,
      });
    })().catch((error: unknown) => {
      logger.warn({ err: error, folderShareId: share.id }, 'failed to record folder link access');
    });
  }

  const expiresAtFor = (hours: number | null | undefined) => {
    const resolved = hours === null ? null : (hours ?? opts.defaultTtlHours);
    return resolved === null ? null : new Date(clock.now().getTime() + resolved * 3_600_000);
  };

  return {
    /** A read-only link to a folder and everything below it. The token is returned only here. */
    async create(input: {
      folderId: string;
      userId: string;
      expiresInHours?: number | null;
      password?: string | null;
    }) {
      const folder = await foldersRepo.findById(pool, input.folderId);
      if (!folder) throw Errors.notFound('Folder');
      const role = await workspacesRepo.findMembership(pool, folder.workspace_id, input.userId);
      if (!role) throw Errors.notFound('Folder');
      requireContributor(role, 'create share links');

      const token = generateToken('fsh');
      const share = await folderSharesRepo.insert(pool, {
        id: randomUUID(),
        folderId: folder.id,
        workspaceId: folder.workspace_id,
        tokenHash: hashToken(token),
        createdBy: input.userId,
        expiresAt: expiresAtFor(input.expiresInHours),
        passwordHash: input.password ? await hashPassword(input.password) : null,
      });
      await audit.record({
        workspaceId: folder.workspace_id,
        actorUserId: input.userId,
        action: 'share.created',
        resourceType: 'folder_share',
        resourceId: share.id,
        metadata: {
          filename: `${folder.name}/`,
          folder: folder.name,
          expiresAt: share.expires_at,
          passwordProtected: share.password_hash !== null,
        },
      });
      return { share, url: `${opts.webUrl}/f/${token}` };
    },

    /** Live links to a folder, for any member of its workspace. */
    async listForFolder(workspaceId: string, folderId: string, userId: string) {
      if (!(await workspacesRepo.findMembership(pool, workspaceId, userId))) throw Errors.notFound('Folder');
      if (!(await foldersRepo.findInWorkspace(pool, workspaceId, folderId))) throw Errors.notFound('Folder');
      return folderSharesRepo.listForFolder(pool, folderId);
    },

    async revoke(shareId: string, userId: string): Promise<void> {
      const share = await requireManageable(shareId, userId);
      await folderSharesRepo.revoke(pool, shareId, clock.now());
      await audit.record({
        workspaceId: share.workspace_id,
        actorUserId: userId,
        action: 'share.revoked',
        resourceType: 'folder_share',
        resourceId: shareId,
      });
    },

    /**
     * Public: what the recipient sees in one folder of the shared tree. Records nothing. Locked
     * links reveal only that a password is needed, not even the folder's name.
     */
    async browse(token: string, grant: string | undefined, folderId: string | undefined) {
      const share = await resolveOrThrow(token);
      if (!unlocked(share, grant)) return { locked: true as const, expiresAt: share.expires_at };

      const path = await folderWithin(share, folderId);
      const current = path[path.length - 1]!;
      const [folders, documents] = await Promise.all([
        folderSharesRepo.subfolders(pool, current.id),
        folderSharesRepo.documents(pool, current.id),
      ]);
      return {
        locked: false as const,
        name: share.folder_name,
        expiresAt: share.expires_at,
        passwordProtected: share.password_hash !== null,
        path,
        folders: folders.slice(0, FOLDER_LISTING_LIMIT).map((f) => ({
          id: f.id,
          name: f.name,
          documentCount: Number(f.document_count),
          folderCount: Number(f.folder_count),
        })),
        documents: documents.slice(0, FOLDER_LISTING_LIMIT).map((d) => ({
          id: d.id,
          filename: d.filename,
          mimeType: d.mime_type,
          size: Number(d.size),
          createdAt: d.created_at,
        })),
        truncated: folders.length > FOLDER_LISTING_LIMIT || documents.length > FOLDER_LISTING_LIMIT,
      };
    },

    /** Checks the link password; same per-link lockout as document links. */
    async unlock(token: string, password: string) {
      const share = await resolveOrThrow(token);
      if (!share.password_hash) return { grant: null, maxAgeSeconds: 0 };
      const windowStart = new Date(clock.now().getTime() - LINK_LOCKOUT_WINDOW_MS);
      if ((await folderSharesRepo.recentFailedUnlocks(pool, share.id, windowStart)) >= LINK_PASSWORD_ATTEMPTS) {
        throw Errors.tooManyRequests(
          'LINK_LOCKED',
          'Too many wrong passwords for this link. Try again later.',
          LINK_LOCKOUT_WINDOW_MS / 1000,
        );
      }
      if (!(await verifyPassword(share.password_hash, password))) {
        await folderSharesRepo.recordFailedUnlock(pool, share.id, windowStart, clock.now());
        throw Errors.credentialRequired('WRONG_PASSWORD', 'That password is not correct.');
      }
      const expiresAt = Math.floor(clock.now().getTime() / 1000) + FOLDER_GRANT_TTL_SECONDS;
      return { grant: signGrant(share, expiresAt), maxAgeSeconds: FOLDER_GRANT_TTL_SECONDS };
    },

    /** Public page-view beacon. */
    async recordView(token: string, visitor: Visitor, grant: string | undefined): Promise<void> {
      const share = await requireUnlocked(token, grant);
      if (!isBot(visitor.userAgent)) recordAccess(share, 'open');
    },

    /** Public: one file from inside the shared folder, as a short-lived signed URL. */
    async downloadUrl(token: string, documentId: string, visitor: Visitor, grant: string | undefined) {
      const share = await requireUnlocked(token, grant);
      const document = await folderSharesRepo.documentWithin(pool, share.folder_id, documentId);
      if (!document) throw Errors.notFound('Document');
      assertScanAllows(document);
      if (isBot(visitor.userAgent)) throw Errors.forbidden('Automated clients cannot download shared files.');
      recordAccess(share, 'download', document.filename);
      return storage.getSignedUrl(document.storage_key, opts.signedUrlTtlSeconds, {
        filename: document.filename,
        contentType: document.mime_type,
      });
    },

    /** Public: what a zip of the shared folder (or a folder below it) would contain. */
    async planArchive(token: string, grant: string | undefined, folderId: string | undefined): Promise<ArchivePlan> {
      const share = await requireUnlocked(token, grant);
      const path = await folderWithin(share, folderId);
      const target = path[path.length - 1]!;
      const rows = await documentsRepo.archiveFolder(pool, share.workspace_id, target.id, opts.archiveMaxFiles + 1);
      if (rows.length === 0) throw Errors.conflict('NOTHING_TO_DOWNLOAD', 'This folder has no files in it.');
      if (rows.length > opts.archiveMaxFiles) {
        throw Errors.payloadTooLargeFor(
          'ARCHIVE_TOO_LARGE',
          `A zip download can hold at most ${opts.archiveMaxFiles} files. Open a subfolder and download that instead.`,
        );
      }
      const plan = planArchive(`${target.name}.zip`, rows);
      if (plan.entries.length === 0) {
        throw Errors.conflict('NOTHING_TO_DOWNLOAD', 'None of these files can be downloaded yet.');
      }
      if (plan.entries.reduce((sum, e) => sum + e.size, 0) > opts.archiveMaxBytes) {
        throw Errors.payloadTooLargeFor(
          'ARCHIVE_TOO_LARGE',
          'This folder is too large to download as one zip. Open a subfolder and download that instead.',
        );
      }
      return plan;
    },

    /** Counts a zip download against the link, once the archive is about to be sent. */
    async recordArchive(token: string, grant: string | undefined, visitor: Visitor, plan: ArchivePlan): Promise<void> {
      const share = await requireUnlocked(token, grant);
      if (isBot(visitor.userAgent)) throw Errors.forbidden('Automated clients cannot download shared files.');
      recordAccess(share, 'download', plan.filename);
    },
  };
}

export type FolderSharesService = ReturnType<typeof createFolderSharesService>;
