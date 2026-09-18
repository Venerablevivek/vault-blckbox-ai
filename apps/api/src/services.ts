import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from './config';
import { createJobQueue } from './jobs/queue';
import { createAuditService } from './modules/audit/audit.service';
import { createAuthService } from './modules/auth/auth.service';
import { createDocumentsService } from './modules/documents/documents.service';
import { createFoldersService } from './modules/folders/folders.service';
import { createMaintenanceService } from './modules/maintenance/maintenance.service';
import { createNotificationsService } from './modules/notifications/notifications.service';
import { createOverviewService } from './modules/overview/overview.service';
import { createSharesService } from './modules/shares/shares.service';
import { createWorkspacesService } from './modules/workspaces/workspaces.service';
import { createUploadsService } from './modules/uploads/uploads.service';
import { ClamdScanner, type Scanner } from './scanning/scanner';
import type { FileStorage } from './storage/file-storage';
import type { MultipartStorage } from './storage/multipart-storage';
import type { Clock } from './types';

/**
 * Builds every service once, with its dependencies. The API server, the background worker and
 * the one-off maintenance command all use this, so they run the same code with the same wiring.
 */
export function createServices(deps: {
  config: Config;
  pool: Pool;
  /** See createDatabase: sessions for LISTEN and locks, and a replica for lag-tolerant reads. */
  directPool?: Pool;
  readPool?: Pool;
  storage: FileStorage;
  multipartStorage: (FileStorage & MultipartStorage) | null;
  logger: Logger;
  clock: Clock;
  /** Overrides the scanner built from SCAN_MODE (tests point it at a stand-in clamd). */
  scanner?: Scanner | null;
}) {
  const { config, pool, storage, multipartStorage, logger, clock } = deps;
  const directPool = deps.directPool ?? pool;
  const readPool = deps.readPool ?? pool;
  const scanner =
    deps.scanner !== undefined
      ? deps.scanner
      : config.SCAN_MODE === 'clamav'
        ? new ClamdScanner(config.CLAMAV_HOST, config.CLAMAV_PORT, config.SCAN_TIMEOUT_MS)
        : null;

  // Cross-cutting services first: the feature modules depend on them.
  const jobs = createJobQueue({ pool, listenPool: directPool, clock, logger });
  const audit = createAuditService({ pool, readPool, clock, logger });
  const notifications = createNotificationsService({ pool, clock, logger, jobs });

  const auth = createAuthService({
    pool,
    clock,
    sessionTtlDays: config.SESSION_TTL_DAYS,
    audit,
    lockoutAttempts: config.LOGIN_LOCKOUT_ATTEMPTS,
    lockoutMinutes: config.LOGIN_LOCKOUT_MINUTES,
    jobs,
    logger,
    webUrl: config.WEB_URL,
    passwordResetTtlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
    emailVerification: config.EMAIL_VERIFICATION,
    emailVerificationTtlHours: config.EMAIL_VERIFICATION_TTL_HOURS,
  });
  const workspaces = createWorkspacesService({
    pool,
    clock,
    inviteTtlHours: config.INVITE_TTL_HOURS,
    webUrl: config.WEB_URL,
    exposeInviteLinks: config.EXPOSE_INVITE_LINKS,
    audit,
    notifications,
    jobs,
    logger,
  });
  const documents = createDocumentsService({
    pool,
    storage,
    clock,
    logger,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    signedUrlTtlSeconds: config.SIGNED_URL_TTL_SECONDS,
    trashRetentionDays: config.TRASH_RETENTION_DAYS,
    audit,
    notifications,
    jobs,
    scanMode: config.SCAN_MODE,
    scanMaxBytes: config.SCAN_MAX_BYTES,
    scanner,
    archiveMaxFiles: config.ARCHIVE_MAX_FILES,
    archiveMaxBytes: config.ARCHIVE_MAX_BYTES,
  });
  const shares = createSharesService({
    pool,
    storage,
    clock,
    logger,
    ipHashPepper: config.IP_HASH_PEPPER,
    grantSecret: config.SHARE_GRANT_SECRET,
    webUrl: config.WEB_URL,
    defaultTtlHours: config.SHARE_DEFAULT_TTL_HOURS,
    signedUrlTtlSeconds: config.SIGNED_URL_TTL_SECONDS,
    audit,
    notifications,
    jobs,
    watermarkMaxBytes: config.SHARE_WATERMARK_MAX_BYTES,
  });
  // The dashboard is all aggregate reads: fine to serve from a replica.
  const overview = createOverviewService({ pool: readPool, clock, audit });
  const folders = createFoldersService({ pool, audit });
  const uploads = multipartStorage
    ? createUploadsService({
        pool,
        storage: multipartStorage,
        clock,
        logger,
        audit,
        notifications,
        jobs,
        maxDirectUploadBytes: config.MAX_DIRECT_UPLOAD_BYTES,
        sessionTtlHours: config.UPLOAD_SESSION_TTL_HOURS,
        partUrlTtlSeconds: config.UPLOAD_PART_URL_TTL_SECONDS,
        scanMode: config.SCAN_MODE,
        scanMaxBytes: config.SCAN_MAX_BYTES,
      })
    : null;
  const maintenance = createMaintenanceService({
    // Holds a session advisory lock for the whole pass, and may run long.
    pool: directPool,
    clock,
    logger,
    documents,
    uploads,
    shareEventRetentionMonths: config.SHARE_EVENT_RETENTION_MONTHS,
  });

  return {
    jobs,
    audit,
    notifications,
    auth,
    workspaces,
    documents,
    shares,
    overview,
    folders,
    uploads,
    maintenance,
    pools: { pool, directPool, readPool },
  };
}

export type Services = ReturnType<typeof createServices>;
