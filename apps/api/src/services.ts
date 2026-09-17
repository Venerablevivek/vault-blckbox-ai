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
import type { FileStorage } from './storage/file-storage';
import type { Clock } from './types';

/**
 * Builds every service once, with its dependencies. The API server, the background worker and
 * the one-off maintenance command all use this, so they run the same code with the same wiring.
 */
export function createServices(deps: {
  config: Config;
  pool: Pool;
  storage: FileStorage;
  logger: Logger;
  clock: Clock;
}) {
  const { config, pool, storage, logger, clock } = deps;

  // Cross-cutting services first: the feature modules depend on them.
  const jobs = createJobQueue({ pool, clock, logger });
  const audit = createAuditService({ pool, clock, logger });
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
  });
  const overview = createOverviewService({ pool, clock, audit });
  const folders = createFoldersService({ pool, audit });
  const maintenance = createMaintenanceService({ pool, clock, logger, documents });

  return { jobs, audit, notifications, auth, workspaces, documents, shares, overview, folders, maintenance };
}

export type Services = ReturnType<typeof createServices>;
