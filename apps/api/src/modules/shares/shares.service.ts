import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/tx';
import { AppError, Errors } from '../../lib/errors';
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
import { assertScanAllows } from '../documents/scan-policy';
import { PREVIEWABLE } from '../documents/documents.service';
import type { JobQueue } from '../../jobs/queue';
import { shareCodeEmail } from '../../mail/templates';
import { watermarkPdf } from './watermark';

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
  jobs: JobQueue;
  /** Largest PDF watermarked for a view-only link; it is held in memory while stamped. */
  watermarkMaxBytes: number;
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

/** How long an unlocked link (password or email) stays unlocked in that browser. */
export const GRANT_TTL_SECONDS = 60 * 60;

/** One-time codes for links restricted to named people. */
export const EMAIL_CODE_TTL_MINUTES = 10;
export const EMAIL_CODE_ATTEMPTS = 5;
/** Codes sent to one address for one link inside the window; more requests are quietly ignored. */
export const EMAIL_CODES_PER_WINDOW = 3;
export const EMAIL_CODE_WINDOW_MS = 15 * 60 * 1000;

/** What a grant cookie proves: which address was verified (if any) and whether the password was given. */
export interface Grant {
  email: string | null;
  password: boolean;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

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
   * A grant is `v2.<expiry>.<email>.<password>.<hmac>`: the address verified with a one-time code
   * (base64url, or "-"), whether the password was given (1/0), and an HMAC over those, the share
   * id and the link's current password hash. Changing or removing the password therefore
   * invalidates every password grant issued under the old one, and removing an address from the
   * link shuts that person out at once (the address is checked against the link on every use).
   * Nothing is stored server-side.
   */
  function signGrant(share: ResolvedShare, grant: Grant, expiresAt: number): string {
    const email = grant.email === null ? '-' : Buffer.from(grant.email).toString('base64url');
    const password = grant.password ? '1' : '0';
    const mac = createHmac('sha256', opts.grantSecret)
      .update(`${share.share_id}.${expiresAt}.${email}.${password}.${grant.password ? share.password_hash : ''}`)
      .digest('base64url');
    return `v2.${expiresAt}.${email}.${password}.${mac}`;
  }

  const NO_GRANT: Grant = { email: null, password: false };

  /** What a presented grant proves for this link; nothing if it is forged, stale or expired. */
  function readGrant(share: ResolvedShare, raw: string | undefined): Grant {
    if (!raw) return NO_GRANT;
    const parts = raw.split('.');
    if (parts.length !== 5 || parts[0] !== 'v2') return NO_GRANT;
    const expiresAt = Number(parts[1]);
    if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(clock.now().getTime() / 1000)) return NO_GRANT;
    const grant: Grant = {
      email: parts[2] === '-' ? null : Buffer.from(parts[2]!, 'base64url').toString('utf8'),
      password: parts[3] === '1' && share.password_hash !== null,
    };
    const expected = Buffer.from(signGrant(share, grant, expiresAt));
    const actual = Buffer.from(raw);
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? grant : NO_GRANT;
  }

  /** Which of the link's locks this browser has opened. */
  function accessOf(share: ResolvedShare, raw: string | undefined) {
    const grant = readGrant(share, raw);
    const restricted = share.allowed_emails.length > 0;
    const email = restricted && grant.email !== null && share.allowed_emails.includes(grant.email) ? grant.email : null;
    return {
      grant,
      email,
      emailOk: !restricted || email !== null,
      passwordOk: share.password_hash === null || grant.password,
    };
  }

  function issueGrant(share: ResolvedShare, grant: Grant) {
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + GRANT_TTL_SECONDS;
    return { grant: signGrant(share, grant, expiresAt), maxAgeSeconds: GRANT_TTL_SECONDS };
  }

  /** Text stamped on what a view-only link shows: who is looking, and when. */
  function watermarkFor(email: string | null, visitor: Visitor): string {
    const who = email ?? `viewer ${hashIp(visitor.ip, opts.ipHashPepper).toString('hex').slice(0, 8)}`;
    const when = clock.now().toISOString().slice(0, 16).replace('T', ' ');
    return `${who} - ${when} UTC - shared via Vault`;
  }

  function codeHash(shareId: string, email: string, code: string): Buffer {
    return createHmac('sha256', opts.grantSecret).update(`code.${shareId}.${email}.${code}`).digest();
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
    viewerEmail: string | null = null,
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
        viewerEmail,
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
    viewerEmail: string | null = null,
  ): void {
    if (isBot(visitor.userAgent)) return;
    // The raw address is never stored: only a keyed hash, enough to count distinct viewers
    // and useless for identifying anyone.
    const ipHash = hashIp(visitor.ip, opts.ipHashPepper);

    void (async () => {
      const successful = outcome === 'resolved' || outcome === 'downloaded';
      const written = await writeAccess(shareId, ipHash, visitor.userAgent, outcome, viewerEmail);
      if (!written) return; // a refresh within the de-duplication window
      const seenBefore = !written.newViewer;

      if (!context) return;

      audit.recordAsync({
        workspaceId: context.workspaceId,
        actorUserId: null,
        action: successful ? 'share.accessed' : 'share.blocked',
        resourceType: 'share',
        resourceId: shareId,
        metadata: { filename: context.filename, outcome, ...(viewerEmail ? { email: viewerEmail } : {}) },
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
        title: viewerEmail
          ? `${viewerEmail} opened your link to ${context.filename}`
          : first
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

  /** Throws unless every lock on the link is open in this browser; returns the verified address. */
  function requireAccess(share: ResolvedShare, raw: string | undefined): string | null {
    const access = accessOf(share, raw);
    if (!access.emailOk) {
      throw Errors.credentialRequired(
        'EMAIL_REQUIRED',
        'This link is only for specific people. Confirm your email address first.',
      );
    }
    if (!access.passwordOk)
      throw Errors.credentialRequired('PASSWORD_REQUIRED', 'This link is protected by a password.');
    return access.email;
  }

  /** Checks a link's view/restriction settings against its document. */
  function validateLinkSettings(mimeType: string, allowDownload: boolean) {
    if (!allowDownload && !PREVIEWABLE.has(mimeType)) {
      throw Errors.unprocessable(
        'VIEW_ONLY_UNSUPPORTED',
        'Only PDFs and images can be shared view-only, because other files can only be downloaded.',
      );
    }
  }

  /**
   * Whether the page may show the file itself. Not for a link with a download limit: showing it
   * would hand out the file without using up a download.
   */
  const canShowInPage = (share: ResolvedShare) =>
    PREVIEWABLE.has(share.mime_type) && (!share.allow_download || share.max_downloads === null);

  const cleanEmails = (emails: string[] | undefined) =>
    emails === undefined ? undefined : [...new Set(emails.map(normalizeEmail))].sort();

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
      allowDownload?: boolean;
      allowedEmails?: string[];
    }) {
      const document = await documentsRepo.findLiveById(pool, input.documentId);
      if (!document) throw Errors.notFound('Document');
      const role = await workspacesRepo.findMembership(pool, document.workspace_id, input.userId);
      if (!role) throw Errors.notFound('Document');
      requireContributor(role, 'create share links');
      // A file still being scanned (or found infected) can't be handed to anyone outside.
      assertScanAllows(document);
      const allowDownload = input.allowDownload ?? true;
      validateLinkSettings(document.mime_type, allowDownload);
      const allowedEmails = cleanEmails(input.allowedEmails) ?? [];

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
        allowDownload,
        allowedEmails,
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
          viewOnly: !allowDownload,
          restrictedTo: allowedEmails.length,
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
      changes: {
        expiresInHours?: number | null;
        password?: string | null;
        maxDownloads?: number | null;
        allowDownload?: boolean;
        allowedEmails?: string[];
      },
    ) {
      const share = await requireManageable(shareId, userId);
      if (share.revoked_at) throw Errors.conflict('LINK_REVOKED', 'A revoked link cannot be edited.');
      if (changes.allowDownload === false) {
        const document = await documentsRepo.findAnyById(pool, share.document_id);
        validateLinkSettings(document?.mime_type ?? '', false);
      }

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
        allowDownload: changes.allowDownload,
        allowedEmails: cleanEmails(changes.allowedEmails),
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
          viewOnly: changes.allowDownload === undefined ? undefined : !changes.allowDownload,
          restrictedTo: changes.allowedEmails?.length,
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
        email: event.viewer_email,
      }));
    },

    /** Every access to a link, newest first, for any member of its workspace (as listEvents). */
    async *exportEvents(shareId: string, userId: string) {
      const share = await sharesRepo.findById(pool, shareId);
      if (!share) throw Errors.notFound('Link');
      if (!(await workspacesRepo.findMembership(pool, share.workspace_id, userId))) throw Errors.notFound('Link');
      let after: { at: Date; id: string } | null = null;
      for (;;) {
        const rows = await sharesRepo.eventsPage(pool, shareId, after, 1000);
        for (const row of rows) {
          yield {
            accessedAt: row.accessed_at,
            outcome: row.outcome,
            viewer: row.ip_hash.toString('hex').slice(0, 8),
            email: row.viewer_email,
            userAgent: row.user_agent,
          };
        }
        if (rows.length < 1000) return;
        const last = rows[rows.length - 1]!;
        after = { at: last.accessed_at, id: last.id };
      }
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
    async resolvePublic(token: string, grant: string | undefined, visitor: Visitor) {
      const share = await resolveOrThrow(token);
      const access = accessOf(share, grant);
      if (!access.emailOk || !access.passwordOk) {
        return {
          locked: true as const,
          requiresEmail: !access.emailOk,
          requiresPassword: !access.passwordOk,
          expiresAt: share.expires_at,
        };
      }
      return {
        locked: false as const,
        passwordProtected: share.password_hash !== null,
        restricted: share.allowed_emails.length > 0,
        viewerEmail: access.email,
        allowDownload: share.allow_download,
        previewable: canShowInPage(share),
        watermark: share.allow_download ? null : watermarkFor(access.email, visitor),
        filename: share.filename,
        mimeType: share.mime_type,
        size: Number(share.size),
        expiresAt: share.expires_at,
        downloadsRemaining: share.max_downloads === null ? null : share.max_downloads - share.download_count,
      };
    },

    /**
     * Sends a one-time code to an address, if the link is restricted to it. The answer is the
     * same whether or not the address is on the link, so the list can't be probed. Repeated
     * requests past EMAIL_CODES_PER_WINDOW are quietly dropped.
     */
    async requestCode(token: string, rawEmail: string, visitor: Visitor): Promise<void> {
      const share = await resolveOrThrow(token, visitor);
      const email = normalizeEmail(rawEmail);
      if (!share.allowed_emails.includes(email)) return;
      const now = clock.now();
      const since = new Date(now.getTime() - EMAIL_CODE_WINDOW_MS);
      if ((await sharesRepo.emailCodesSince(pool, share.share_id, email, since)) >= EMAIL_CODES_PER_WINDOW) return;

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await withTransaction(pool, async (tx) => {
        await sharesRepo.supersedeEmailCodes(tx, share.share_id, email, now);
        await sharesRepo.insertEmailCode(tx, {
          id: randomUUID(),
          shareId: share.share_id,
          email,
          codeHash: codeHash(share.share_id, email, code),
          expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MINUTES * 60_000),
          now,
        });
        await opts.jobs.enqueue(
          tx,
          'email.send',
          shareCodeEmail({ to: email, code, ttlMinutes: EMAIL_CODE_TTL_MINUTES }),
        );
      });
    },

    /**
     * Checks a one-time code and, if right, issues a grant naming the address (keeping a password
     * already given in this browser). Only the newest code for the address works, each for
     * EMAIL_CODE_ATTEMPTS tries. Every wrong code is recorded, so the sender can see it.
     */
    async verifyCode(token: string, rawEmail: string, code: string, visitor: Visitor, grant: string | undefined) {
      const share = await resolveOrThrow(token, visitor);
      const email = normalizeEmail(rawEmail);
      const invalid = () =>
        Errors.credentialRequired('CODE_INVALID', 'That code is no longer valid. Ask for a new one.');

      const row = share.allowed_emails.includes(email)
        ? await sharesRepo.liveEmailCode(pool, share.share_id, email)
        : null;
      if (!row || row.expires_at <= clock.now() || row.attempts >= EMAIL_CODE_ATTEMPTS) {
        throw invalid();
      }
      if (!timingSafeEqual(codeHash(share.share_id, email, code), row.code_hash)) {
        const attempts = await sharesRepo.failEmailCode(pool, row.id);
        await writeAccess(share.share_id, hashIp(visitor.ip, opts.ipHashPepper), visitor.userAgent, 'bad_code', email);
        if (attempts >= EMAIL_CODE_ATTEMPTS) throw invalid();
        throw Errors.credentialRequired('WRONG_CODE', 'That code is not correct.');
      }
      if (!(await sharesRepo.consumeEmailCode(pool, row.id, clock.now()))) throw invalid();
      return issueGrant(share, { email, password: accessOf(share, grant).grant.password });
    },

    /**
     * Checks a link password and issues a grant for this browser.
     *
     * Guessing is throttled per link, not only per IP: after LINK_PASSWORD_ATTEMPTS wrong
     * passwords in the window the link refuses further attempts, whichever addresses they come
     * from. Every wrong password is recorded, so the sender can see it.
     */
    async unlock(token: string, password: string, visitor: Visitor, grant: string | undefined) {
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

      // Keeps an address already verified in this browser.
      return issueGrant(share, { email: accessOf(share, grant).grant.email, password: true });
    },

    /** Public: records one page view, sent by the recipient's browser once the page loads. */
    async recordView(token: string, visitor: Visitor, grant: string | undefined): Promise<void> {
      const share = await resolveOrThrow(token, visitor);
      // A locked page is not a view of the document. It counts once the link is unlocked.
      const email = requireAccess(share, grant);
      record(share.share_id, visitor, 'resolved', contextOf(share), email);
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
      const email = requireAccess(share, grant);
      if (!share.allow_download) {
        throw new AppError(403, 'DOWNLOAD_DISABLED', 'The sender shared this file for viewing only.');
      }
      if (isBot(visitor.userAgent)) {
        throw Errors.forbidden('Automated clients cannot download shared files.');
      }
      if (!(await sharesRepo.claimDownload(pool, share.share_id, clock.now()))) {
        // Lost a race for the last download, or the link died since it was resolved.
        await resolveOrThrow(token, visitor);
        throw Errors.gone('This link has reached its download limit.');
      }
      record(share.share_id, visitor, 'downloaded', contextOf(share), email);
      return storage.getSignedUrl(share.storage_key, opts.signedUrlTtlSeconds, {
        filename: share.filename,
        contentType: share.mime_type,
      });
    },

    /**
     * Public: the file itself, for showing in the page (PDFs and images only). Streamed through
     * the API rather than handed out as a signed URL, so a view-only link never reveals a URL
     * that downloads the original. A view-only PDF comes back with the viewer's watermark burned
     * into every page; one that can't be stamped is refused rather than shown unmarked.
     * Recording is left to the page-view beacon, so showing the file doesn't count twice.
     */
    async content(
      token: string,
      visitor: Visitor,
      grant: string | undefined,
    ): Promise<{ body: Readable | Buffer; contentType: string; filename: string; size: number }> {
      const share = await resolveOrThrow(token, visitor);
      const email = requireAccess(share, grant);
      if (!PREVIEWABLE.has(share.mime_type)) {
        throw Errors.unsupportedMediaType('This type of file cannot be shown in the browser.');
      }
      if (!canShowInPage(share)) {
        throw Errors.forbidden('This link has a download limit, so the file is only available as a download.');
      }
      if (isBot(visitor.userAgent)) throw Errors.forbidden('Automated clients cannot open shared files.');

      if (share.allow_download || share.mime_type !== 'application/pdf') {
        return {
          body: await storage.download(share.storage_key),
          contentType: share.mime_type,
          filename: share.filename,
          size: Number(share.size),
        };
      }

      if (Number(share.size) > opts.watermarkMaxBytes) {
        throw new AppError(
          413,
          'TOO_LARGE_TO_VIEW',
          'This file is too large to view online. Ask the sender for a copy.',
        );
      }
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.download(share.storage_key)) chunks.push(chunk as Buffer);
      let marked: Buffer;
      try {
        marked = await watermarkPdf(Buffer.concat(chunks), watermarkFor(email, visitor));
      } catch (error) {
        logger.warn({ err: error, shareId: share.share_id }, 'could not watermark a view-only PDF');
        throw Errors.unprocessable(
          'PREVIEW_UNAVAILABLE',
          'This PDF cannot be shown online. Ask the sender for a copy.',
        );
      }
      return { body: marked, contentType: 'application/pdf', filename: share.filename, size: marked.length };
    },
  };
}

export type SharesService = ReturnType<typeof createSharesService>;
