import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { generateToken, hashIp, hashToken } from '../../lib/tokens';
import { Permissions, requireContributor } from '../../policy';
import type { FileStorage } from '../../storage/file-storage';
import type { Clock } from '../../types';
import { hashPassword, verifyPassword } from '../auth/password';
import { documentsRepo } from '../documents/documents.repo';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { sharesRepo, type AccessOutcome, type ResolvedShare, type ShareActivity } from './shares.repo';

export interface SharesServiceOptions {
  pool: Pool;
  storage: FileStorage;
  clock: Clock;
  logger: Logger;
  webUrl: string;
  defaultTtlHours: number;
  signedUrlTtlSeconds: number;
  ipHashPepper: string;
  grantSecret: string;
  audit: AuditService;
  notifications: NotificationsService;
}

/** Who is knocking. Captured per public request so access can be counted. */
export interface Visitor {
  ip: string;
  userAgent: string | null;
}

/** Distinct networks on a link before forwarding is worth flagging. */
const FORWARDING_THRESHOLD = 3;

/** Repeat views by the same visitor inside this window count once. */
export const VIEW_DEDUPE_MS = 30 * 60 * 1000;

/** Wrong passwords allowed per link in LOCKOUT_WINDOW_MS before the link refuses attempts. */
export const LINK_PASSWORD_ATTEMPTS = 10;
export const LINK_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/** How long an unlocked password-protected link stays unlocked in that browser. */
export const GRANT_TTL_SECONDS = 60 * 60;

/**
 * Link unfurlers and crawlers fetch shared URLs without a person behind them. Deliberately
 * narrow: names like "LinkedIn" or "Telegram" also appear in the in-app browsers real people
 * use, so only crawler and link-preview agents are matched.
 */
const BOT_USER_AGENT = /bot\b|crawler|spider|slurp|facebookexternalhit|embedly|whatsapp\/|skypeuripreview/i;

export function isBot(userAgent: string | null): boolean {
  return userAgent !== null && BOT_USER_AGENT.test(userAgent);
}

/**
 * Name of the cookie that holds the unlock grant for one link. Derived from the token's hash,
 * so each protected link has its own grant and unlocking one never unlocks another.
 */
export function grantCookieName(token: string): string {
  return `sg_${hashToken(token).toString('hex').slice(0, 16)}`;
}

export function createSharesService(opts: SharesServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications } = opts;

  /**
   * A grant is `<expiry>.<hmac>`, where the HMAC covers the share id, the expiry and the
   * link's current password hash. Changing or removing the password therefore invalidates
   * every grant issued under the old one. Nothing is stored server-side.
   */
  function signGrant(shareId: string, passwordHash: string, expiresAt: number): string {
    const mac = createHmac('sha256', opts.grantSecret)
      .update(`${shareId}.${expiresAt}.${passwordHash}`)
      .digest('base64url');
    return `${expiresAt}.${mac}`;
  }

  function grantIsValid(share: ResolvedShare, grant: string | undefined): boolean {
    if (!share.password_hash) return true;
    if (!grant) return false;
    const [expiry, mac] = grant.split('.');
    const expiresAt = Number(expiry);
    if (!mac || !Number.isFinite(expiresAt) || expiresAt < Math.floor(clock.now().getTime() / 1000)) return false;
    const expected = Buffer.from(signGrant(share.share_id, share.password_hash, expiresAt));
    const actual = Buffer.from(grant);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Months whose event partition this process has already made sure exists. */
  const ensuredMonths = new Set<string>();

  /**
   * Writes one access in a single transaction: the event row, the link's counters and, for a
   * successful access, the viewer record. Returns null when a page view is a repeat within the
   * de-duplication window (nothing is written), otherwise whether the viewer is new and the
   * link's distinct viewer count.
   */
  async function writeAccess(
    shareId: string,
    ipHash: Buffer,
    userAgent: string | null,
    outcome: AccessOutcome,
  ): Promise<{ newViewer: boolean; viewers: number } | null> {
    const at = clock.now();
    const month = at.toISOString().slice(0, 7);
    if (!ensuredMonths.has(month)) {
      await sharesRepo.ensureEventPartition(pool, at);
      ensuredMonths.add(month);
    }

    return withTransaction(pool, async (tx) => {
      let result: { newViewer: boolean; viewers: number } = { newViewer: false, viewers: 0 };
      if (outcome === 'resolved' || outcome === 'downloaded') {
        const viewer =
          outcome === 'resolved'
            ? await sharesRepo.upsertViewerForView(tx, shareId, ipHash, at, new Date(at.getTime() - VIEW_DEDUPE_MS))
            : await sharesRepo.upsertViewerForDownload(tx, shareId, ipHash, at);
        if (!viewer) return null;
        const viewers = await sharesRepo.countSuccess(tx, shareId, {
          view: outcome === 'resolved',
          newViewer: viewer.newViewer,
          at,
        });
        result = { newViewer: viewer.newViewer, viewers };
      } else {
        await sharesRepo.countBlocked(tx, shareId);
      }
      await sharesRepo.insertEvent(tx, {
        id: randomUUID(),
        shareId,
        ipHash,
        userAgent: userAgent?.slice(0, 500) ?? null,
        outcome,
        at,
      });
      return result;
    });
  }

  /** Writes one access event, then decides whether the link's creator should hear about it. */
  function record(
    shareId: string,
    visitor: Visitor,
    outcome: AccessOutcome,
    context?: { workspaceId: string; documentId: string; filename: string; createdBy: string },
  ): void {
    if (isBot(visitor.userAgent)) return;
    // The raw address is never stored: only a keyed hash, enough to count distinct viewers
    // and useless for identifying anyone.
    const ipHash = hashIp(visitor.ip, opts.ipHashPepper);

    void (async () => {
      const successful = outcome === 'resolved' || outcome === 'downloaded';
      const written = await writeAccess(shareId, ipHash, visitor.userAgent, outcome);
      if (!written) return; // a refresh within the de-duplication window
      const seenBefore = !written.newViewer;

      if (!context) return;

      audit.recordAsync({
        workspaceId: context.workspaceId,
        actorUserId: null,
        action: successful ? 'share.accessed' : 'share.blocked',
        resourceType: 'share',
        resourceId: shareId,
        metadata: { filename: context.filename, outcome },
      });

      if (!successful || seenBefore) return;

      // Only notify someone who is still in the workspace. Their links are revoked when they
      // leave, but this check means a removed person can never learn about workspace
      // documents through a notification, whatever state the link is in.
      const creatorRole = await workspacesRepo.findMembership(pool, context.workspaceId, context.createdBy);
      if (!creatorRole) return;

      const viewers = written.viewers;
      const first = viewers <= 1;
      notifications.notify({
        userId: context.createdBy,
        workspaceId: context.workspaceId,
        type: first ? 'share.first_open' : 'share.new_viewer',
        title: first
          ? `Your link to ${context.filename} was opened`
          : `Someone else opened your link to ${context.filename}`,
        body: first ? 'This is the first time anyone has opened it.' : `${viewers} people have now opened this link.`,
        resourceId: context.documentId,
      });
      if (viewers === FORWARDING_THRESHOLD) {
        notifications.notify({
          userId: context.createdBy,
          workspaceId: context.workspaceId,
          type: 'share.forwarding_suspected',
          title: `${context.filename} has been opened from ${viewers} different networks`,
          body: 'If you sent this link to one person, consider revoking it and issuing a new one.',
          resourceId: context.documentId,
        });
      }
    })().catch((error: unknown) => {
      logger.warn({ err: error, shareId, outcome }, 'failed to record share access event');
    });
  }

  function contextOf(share: ResolvedShare) {
    return {
      workspaceId: share.workspace_id,
      documentId: share.document_id,
      filename: share.filename,
      createdBy: share.created_by,
    };
  }

  /**
   * Resolves a public token to a usable link, or throws 404 (never existed) or 410 (existed
   * but is revoked, expired, used up, or its document is in the trash). With a visitor, the
   * failed attempt is recorded against the link.
   */
  async function resolveOrThrow(token: string, visitor?: Visitor): Promise<ResolvedShare> {
    const tokenHash = hashToken(token);
    const share = await sharesRepo.resolveLive(pool, tokenHash, clock.now());
    if (share) return share;

    const state = await sharesRepo.findStateByTokenHash(pool, tokenHash);
    if (!state) throw Errors.notFound('Link');

    const reason: AccessOutcome = state.revoked_at
      ? 'revoked'
      : state.document_deleted_at
        ? 'document_deleted'
        : state.max_downloads !== null && state.download_count >= state.max_downloads
          ? 'exhausted'
          : 'expired';
    if (visitor) record(state.id, visitor, reason);

    throw Errors.gone(
      reason === 'exhausted' ? 'This link has reached its download limit.' : 'This link is no longer available.',
    );
  }

  function requireGrant(share: ResolvedShare, grant: string | undefined): void {
    if (!grantIsValid(share, grant)) {
      throw Errors.credentialRequired('PASSWORD_REQUIRED', 'This link is protected by a password.');
    }
  }

  function expiresAtFor(hours: number | null | undefined): Date | null {
    const resolved = hours === null ? null : (hours ?? opts.defaultTtlHours);
    return resolved === null ? null : new Date(clock.now().getTime() + resolved * 3_600_000);
  }

  /** Looks up a link for its manager, checking workspace membership and the ownership rule. */
  async function requireManageable(shareId: string, userId: string) {
    const share = await sharesRepo.findById(pool, shareId);
    if (!share) throw Errors.notFound('Link');
    const role = await workspacesRepo.findMembership(pool, share.workspace_id, userId);
    if (!role) throw Errors.notFound('Link');
    if (!Permissions.canManageShare(role, share.created_by, userId)) {
      throw Errors.forbidden('Only the link creator or a workspace owner can change it.');
    }
    return share;
  }

  return {
    /**
     * Creates a read-only public link to one document, optionally protected by a password and
     * limited to a number of downloads (1 = a one-time link).
     *
     * The token is 256 bits of randomness and only its SHA-256 hash is stored, so the plaintext
     * returned here is the only time it exists outside the recipient's address bar.
     */
    async create(input: {
      documentId: string;
      userId: string;
      expiresInHours?: number | null;
      password?: string | null;
      maxDownloads?: number | null;
    }) {
      const document = await documentsRepo.findLiveById(pool, input.documentId);
      if (!document) throw Errors.notFound('Document');
      const role = await workspacesRepo.findMembership(pool, document.workspace_id, input.userId);
      if (!role) throw Errors.notFound('Document');
      requireContributor(role, 'create share links');

      const token = generateToken('shr');
      const passwordHash = input.password ? await hashPassword(input.password) : null;
      const share = await sharesRepo.insert(pool, {
        id: randomUUID(),
        documentId: document.id,
        tokenHash: hashToken(token),
        expiresAt: expiresAtFor(input.expiresInHours),
        createdBy: input.userId,
        passwordHash,
        maxDownloads: input.maxDownloads ?? null,
      });

      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: input.userId,
        action: 'share.created',
        resourceType: 'share',
        resourceId: share.id,
        metadata: {
          filename: document.filename,
          expiresAt: share.expires_at,
          passwordProtected: passwordHash !== null,
          maxDownloads: share.max_downloads,
        },
      });

      return { share, url: `${opts.webUrl}/s/${token}`, token };
    },

    /**
     * Edits a live link: expiry, password, download limit. The URL does not change, so the
     * recipient keeps the link they already have.
     */
    async update(
      shareId: string,
      userId: string,
      changes: { expiresInHours?: number | null; password?: string | null; maxDownloads?: number | null },
    ) {
      const share = await requireManageable(shareId, userId);
      if (share.revoked_at) throw Errors.conflict('LINK_REVOKED', 'A revoked link cannot be edited.');

      if (
        changes.maxDownloads !== undefined &&
        changes.maxDownloads !== null &&
        changes.maxDownloads <= share.download_count
      ) {
        throw Errors.unprocessable(
          'LIMIT_BELOW_USAGE',
          `This link has already been downloaded ${share.download_count} time${share.download_count === 1 ? '' : 's'}. Set a higher limit.`,
        );
      }

      const updated = await sharesRepo.updateSettings(pool, shareId, {
        expiresAt: changes.expiresInHours !== undefined ? expiresAtFor(changes.expiresInHours) : undefined,
        passwordHash:
          changes.password === undefined
            ? undefined
            : changes.password === null
              ? null
              : await hashPassword(changes.password),
        maxDownloads: changes.maxDownloads,
      });

      await audit.record({
        workspaceId: share.workspace_id,
        actorUserId: userId,
        action: 'share.updated',
        resourceType: 'share',
        resourceId: shareId,
        // Which settings changed, never the password itself.
        metadata: {
          expiry: changes.expiresInHours !== undefined,
          password: changes.password === undefined ? undefined : changes.password === null ? 'removed' : 'set',
          maxDownloads: changes.maxDownloads,
        },
      });
      return updated;
    },

    /** Live links for a document, each with its access rollup. */
    async listForDocument(documentId: string) {
      const shares = await sharesRepo.listForDocument(pool, documentId);
      const activity = await sharesRepo.activityFor(
        pool,
        shares.map((s) => s.id),
      );
      const empty: ShareActivity = {
        opens: 0,
        downloads: 0,
        distinctViewers: 0,
        firstAccessedAt: null,
        lastAccessedAt: null,
        blockedAttempts: 0,
      };
      return shares.map((share) => ({ share, activity: activity.get(share.id) ?? empty }));
    },

    async listEvents(shareId: string, userId: string) {
      const share = await sharesRepo.findById(pool, shareId);
      if (!share) throw Errors.notFound('Link');
      const role = await workspacesRepo.findMembership(pool, share.workspace_id, userId);
      if (!role) throw Errors.notFound('Link');
      const events = await sharesRepo.listEvents(pool, shareId);
      return events.map((event) => ({
        accessedAt: event.accessed_at,
        outcome: event.outcome,
        userAgent: event.user_agent,
        viewer: event.ip_hash.toString('hex').slice(0, 8),
      }));
    },

    async revoke(shareId: string, userId: string): Promise<void> {
      const share = await requireManageable(shareId, userId);
      await sharesRepo.revoke(pool, shareId, clock.now());
      await audit.record({
        workspaceId: share.workspace_id,
        actorUserId: userId,
        action: 'share.revoked',
        resourceType: 'share',
        resourceId: shareId,
      });
    },

    /**
     * Public metadata. Records nothing (it is called during the server render). For a
     * password-protected link that has not been unlocked in this browser, it reveals only that
     * a password is needed: no filename, size or type.
     */
    async resolvePublic(token: string, grant: string | undefined) {
      const share = await resolveOrThrow(token);
      const unlocked = grantIsValid(share, grant);
      if (!unlocked) {
        return { requiresPassword: true as const, expiresAt: share.expires_at };
      }
      return {
        requiresPassword: false as const,
        passwordProtected: share.password_hash !== null,
        filename: share.filename,
        mimeType: share.mime_type,
        size: Number(share.size),
        expiresAt: share.expires_at,
        downloadsRemaining: share.max_downloads === null ? null : share.max_downloads - share.download_count,
      };
    },

    /**
     * Checks a link password and issues a grant for this browser.
     *
     * Guessing is throttled per link, not only per IP: after LINK_PASSWORD_ATTEMPTS wrong
     * passwords in the window the link refuses further attempts, whichever addresses they come
     * from. Every wrong password is recorded, so the sender can see it.
     */
    async unlock(token: string, password: string, visitor: Visitor) {
      const share = await resolveOrThrow(token, visitor);
      if (!share.password_hash) {
        return { grant: null, maxAgeSeconds: 0 };
      }

      const since = new Date(clock.now().getTime() - LINK_LOCKOUT_WINDOW_MS);
      if ((await sharesRepo.recentBadPasswords(pool, share.share_id, since)) >= LINK_PASSWORD_ATTEMPTS) {
        throw Errors.tooManyRequests(
          'LINK_LOCKED',
          'Too many wrong passwords for this link. Try again later.',
          LINK_LOCKOUT_WINDOW_MS / 1000,
        );
      }

      if (!(await verifyPassword(share.password_hash, password))) {
        // Awaited, not fire-and-forget: the lockout count depends on this row existing.
        await writeAccess(share.share_id, hashIp(visitor.ip, opts.ipHashPepper), visitor.userAgent, 'bad_password');
        throw Errors.credentialRequired('WRONG_PASSWORD', 'That password is not correct.');
      }

      const expiresAt = Math.floor(clock.now().getTime() / 1000) + GRANT_TTL_SECONDS;
      return { grant: signGrant(share.share_id, share.password_hash, expiresAt), maxAgeSeconds: GRANT_TTL_SECONDS };
    },

    /** Public: records one page view, sent by the recipient's browser once the page loads. */
    async recordView(token: string, visitor: Visitor, grant: string | undefined): Promise<void> {
      const share = await resolveOrThrow(token, visitor);
      // A locked page is not a view of the document. It counts once the password is entered.
      requireGrant(share, grant);
      record(share.share_id, visitor, 'resolved', contextOf(share));
    },

    /**
     * Public: re-validates everything, claims one download against the link's limit, then
     * mints a 60-second signed URL.
     *
     * Known crawlers are refused before a download is claimed: a link preview must never use
     * up a one-time link before the person it was meant for opens it.
     */
    async downloadUrl(token: string, visitor: Visitor, grant: string | undefined): Promise<string> {
      const share = await resolveOrThrow(token, visitor);
      requireGrant(share, grant);
      if (isBot(visitor.userAgent)) {
        throw Errors.forbidden('Automated clients cannot download shared files.');
      }
      if (!(await sharesRepo.claimDownload(pool, share.share_id, clock.now()))) {
        // Lost a race for the last download, or the link died since it was resolved.
        await resolveOrThrow(token, visitor);
        throw Errors.gone('This link has reached its download limit.');
      }
      record(share.share_id, visitor, 'downloaded', contextOf(share));
      return storage.getSignedUrl(share.storage_key, opts.signedUrlTtlSeconds, {
        filename: share.filename,
        contentType: share.mime_type,
      });
    },
  };
}

export type SharesService = ReturnType<typeof createSharesService>;
