import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { Errors } from '../../lib/errors';
import { generateToken, hashIp, hashToken } from '../../lib/tokens';
import { Permissions } from '../../policy';
import type { FileStorage } from '../../storage/file-storage';
import type { Clock } from '../../types';
import { documentsRepo } from '../documents/documents.repo';
import { workspacesRepo } from '../workspaces/workspaces.repo';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { sharesRepo, type AccessOutcome, type ShareActivity } from './shares.repo';

/** Distinct networks on a link before forwarding is worth flagging. */
const FORWARDING_THRESHOLD = 3;

/**
 * Repeat views by the same visitor inside this window count once. Without it every refresh
 * was an "open", so a single person reloading a page looked like sustained interest.
 */
export const VIEW_DEDUPE_MS = 30 * 60 * 1000;

/**
 * Link unfurlers and crawlers fetch shared URLs without a person behind them. The page
 * view is already counted by a browser-side request that these do not execute; this also
 * keeps them out of download counts and notifications.
 */
// Deliberately narrow: names like "LinkedIn" or "Telegram" also appear in the in-app browsers
// real people use, so only crawler and link-preview agents are matched ("Slackbot",
// "LinkedInBot", "TelegramBot" and "Discordbot" all end in "bot").
const BOT_USER_AGENT =
  /bot\b|crawler|spider|slurp|facebookexternalhit|embedly|whatsapp\/|skypeuripreview/i;

export function isBot(userAgent: string | null): boolean {
  return userAgent !== null && BOT_USER_AGENT.test(userAgent);
}

export interface SharesServiceOptions {
  pool: Pool;
  storage: FileStorage;
  clock: Clock;
  logger: Logger;
  webUrl: string;
  defaultTtlHours: number;
  signedUrlTtlSeconds: number;
  ipHashPepper: string;
  audit: AuditService;
  notifications: NotificationsService;
}

/** Who is knocking. Captured per public request so access can be counted. */
export interface Visitor {
  ip: string;
  userAgent: string | null;
}

export function createSharesService(opts: SharesServiceOptions) {
  const { pool, storage, clock, logger, audit, notifications } = opts;

  /**
   * Writes one access event.
   *
   * Never awaited by the caller's critical path and never allowed to throw: telemetry
   * failing must not stop someone downloading a document they are entitled to.
   */
  function record(
    shareId: string,
    visitor: Visitor,
    outcome: AccessOutcome,
    context?: { workspaceId: string; documentId: string; filename: string; createdBy: string },
  ): void {
    if (isBot(visitor.userAgent)) return;

    // The raw address is never stored — only a keyed hash, which is enough to count
    // distinct viewers and useless for identifying anyone.
    const ipHash = hashIp(visitor.ip, opts.ipHashPepper);

    void (async () => {
      const successful = outcome === 'resolved' || outcome === 'downloaded';

      if (outcome === 'resolved') {
        const since = new Date(clock.now().getTime() - VIEW_DEDUPE_MS);
        if (await sharesRepo.hasRecentView(pool, shareId, ipHash, since)) return;
      }

      // Ask before writing: "is this a viewer we have seen on this link?" decides whether
      // the sender hears about it, and the answer changes the moment the row lands.
      const seenBefore =
        successful && context ? await sharesRepo.hasSeenViewer(pool, shareId, ipHash) : true;

      await sharesRepo.recordAccess(pool, {
        id: randomUUID(),
        shareId,
        ipHash,
        userAgent: visitor.userAgent?.slice(0, 500) ?? null,
        outcome,
        at: clock.now(),
      });

      if (!context) return;

      audit.recordAsync({
        workspaceId: context.workspaceId,
        actorUserId: null, // anonymous: the visitor has no account here
        action: successful ? 'share.accessed' : 'share.blocked',
        resourceType: 'share',
        resourceId: shareId,
        metadata: { filename: context.filename, outcome },
      });

      if (!successful || seenBefore) return;

      // A new viewer. Tell the person who created the link — and only them.
      const viewers = await sharesRepo.distinctViewerCount(pool, shareId);
      const first = viewers <= 1;

      notifications.notify({
        userId: context.createdBy,
        workspaceId: context.workspaceId,
        type: first ? 'share.first_open' : 'share.new_viewer',
        title: first
          ? `Your link to ${context.filename} was opened`
          : `Someone else opened your link to ${context.filename}`,
        body: first
          ? 'This is the first time anyone has opened it.'
          : `${viewers} people have now opened this link.`,
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

  /**
   * Resolves a public token to a live share, or throws.
   *
   * With a visit, access is recorded: a token that exists but is dead gets 410 and an event
   * against it (someone hitting a revoked link is exactly the signal the sender wants); an
   * unknown token gets 404 and no event, because there is nothing to attach it to.
   * Without a visit (the server-rendered metadata lookup) nothing is recorded.
   */
  async function resolveOrThrow(
    token: string,
    visit?: { visitor: Visitor; outcome: 'resolved' | 'downloaded' },
  ) {
    const tokenHash = hashToken(token);

    const share = await sharesRepo.resolveLive(pool, tokenHash, clock.now());
    if (share) {
      if (!visit) return share;
      record(share.share_id, visit.visitor, visit.outcome, {
        workspaceId: share.workspace_id,
        documentId: share.document_id,
        filename: share.filename,
        createdBy: share.created_by,
      });
      return share;
    }

    const state = await sharesRepo.findStateByTokenHash(pool, tokenHash);
    if (!state) throw Errors.notFound('Link');

    const reason: AccessOutcome = state.revoked_at
      ? 'revoked'
      : state.document_deleted_at
        ? 'document_deleted'
        : 'expired';
    if (visit) record(state.id, visit.visitor, reason);

    throw Errors.gone('This link is no longer available.');
  }

  return {
    /**
     * Creates a read-only public link to one document.
     *
     * The token is 256 bits of randomness and only its SHA-256 hash is stored, so the
     * plaintext returned here is the single time it ever exists outside the recipient's
     * URL bar. A leaked database dump yields no usable links.
     */
    async create(input: { documentId: string; userId: string; expiresInHours?: number | null }) {
      const document = await documentsRepo.findLiveById(pool, input.documentId);
      if (!document) throw Errors.notFound('Document');

      const role = await workspacesRepo.findMembership(pool, document.workspace_id, input.userId);
      if (!role) throw Errors.notFound('Document');

      const hours =
        input.expiresInHours === null ? null : (input.expiresInHours ?? opts.defaultTtlHours);
      const expiresAt = hours === null ? null : new Date(clock.now().getTime() + hours * 3_600_000);

      const token = generateToken('shr');
      const share = await sharesRepo.insert(pool, {
        id: randomUUID(),
        documentId: document.id,
        tokenHash: hashToken(token),
        expiresAt,
        createdBy: input.userId,
      });

      await audit.record({
        workspaceId: document.workspace_id,
        actorUserId: input.userId,
        action: 'share.created',
        resourceType: 'share',
        resourceId: share.id,
        metadata: { filename: document.filename, expiresAt },
      });

      return { share, url: `${opts.webUrl}/s/${token}`, token };
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

    /** Access history for one link. Authorization is the document's. */
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
        // A short prefix of the hash, so the UI can group "the same viewer" without ever
        // handling anything that identifies a person.
        viewer: event.ip_hash.toString('hex').slice(0, 8),
      }));
    },

    async revoke(shareId: string, userId: string): Promise<void> {
      const share = await sharesRepo.findById(pool, shareId);
      if (!share) throw Errors.notFound('Link');

      const role = await workspacesRepo.findMembership(pool, share.workspace_id, userId);
      if (!role) throw Errors.notFound('Link');

      if (!Permissions.canRevokeShare(role, share.created_by, userId)) {
        throw Errors.forbidden('Only the link creator or the workspace owner can revoke it.');
      }

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
     * Public: metadata only. Never the object key, workspace, or uploader identity.
     *
     * Records nothing. This is called by the web server while rendering the share page, so
     * the address it sees is the web container's, not the visitor's; counting here made
     * every visitor look like the same person and counted every render and link preview.
     */
    async resolvePublic(token: string) {
      const share = await resolveOrThrow(token);
      return {
        filename: share.filename,
        mimeType: share.mime_type,
        size: Number(share.size),
        expiresAt: share.expires_at,
      };
    },

    /**
     * Public: records one page view. Called by the recipient's browser once the share page
     * has loaded, so it arrives through the web proxy with the visitor's real address, and
     * link-preview bots (which do not run JavaScript) never send it.
     */
    async recordView(token: string, visitor: Visitor): Promise<void> {
      await resolveOrThrow(token, { visitor, outcome: 'resolved' });
    },

    /** Public: re-validates everything, then mints a short-lived signed URL. */
    async downloadUrl(token: string, visitor: Visitor): Promise<string> {
      const share = await resolveOrThrow(token, { visitor, outcome: 'downloaded' });
      return storage.getSignedUrl(share.storage_key, opts.signedUrlTtlSeconds, {
        filename: share.filename,
        contentType: share.mime_type,
      });
    },
  };
}

export type SharesService = ReturnType<typeof createSharesService>;
