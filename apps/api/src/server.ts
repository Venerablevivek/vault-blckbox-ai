import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './plugins/errors';
import { registerSession } from './plugins/session';
import { createAuthService } from './modules/auth/auth.service';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import { createWorkspacesService } from './modules/workspaces/workspaces.service';
import {
  registerInvitationRoutes,
  registerWorkspaceRoutes,
} from './modules/workspaces/workspaces.routes';
import { createDocumentsService } from './modules/documents/documents.service';
import { registerDocumentRoutes } from './modules/documents/documents.routes';
import { createSharesService } from './modules/shares/shares.service';
import { registerShareRoutes } from './modules/shares/shares.routes';
import { createAuditService } from './modules/audit/audit.service';
import { registerAuditRoutes } from './modules/audit/audit.routes';
import { createNotificationsService } from './modules/notifications/notifications.service';
import { registerNotificationRoutes } from './modules/notifications/notifications.routes';
import { createOverviewService } from './modules/overview/overview.service';
import { createFoldersService } from './modules/folders/folders.service';
import { registerFolderRoutes } from './modules/folders/folders.routes';
import { createMaintenanceService } from './modules/maintenance/maintenance.service';
import { LogMailer, SmtpMailer } from './mail/mailer';
import { systemClock, type AppDeps } from './types';

/**
 * Builds the application with its dependencies injected.
 *
 * Nothing here reads the environment, opens a socket or connects to anything — that is
 * `main.ts`'s job. Keeping `buildApp` pure is what lets the integration tests construct a
 * real server, with real routes and real guards, against a test database.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, pool, storage, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const mailer =
    deps.mailer ?? (config.SMTP_URL ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) : new LogMailer(logger));

  // Cast to FastifyBaseLogger so the instance keeps Fastify's default generic parameters.
  // Passing a concrete pino Logger would specialise FastifyInstance and make every
  // route-registration signature in the modules incompatible.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Only the configured proxies may speak for the client — see TRUSTED_PROXIES in config.ts.
    trustProxy: config.TRUSTED_PROXIES,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    // The API serves JSON and redirects only; it never renders HTML.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie);
  // Rate limiting is per-route (`config.rateLimit`), so a document listing is not
  // throttled like a login attempt.
  //
  // It is not registered under NODE_ENV=test: every request in the suite comes from the
  // same address, so the limiter would throttle the tests rather than the attack it is
  // there to stop. Route-level `config.rateLimit` is simply ignored when the plugin is
  // absent. The trade-off is that the limits themselves are not covered by tests.
  if (config.NODE_ENV !== 'test') {
    await app.register(rateLimit, { global: false, max: 100, timeWindow: '1 minute' });
  }
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
  });

  registerErrorHandler(app);

  // Cross-cutting services, built first because the feature modules depend on them.
  const audit = createAuditService({ pool, clock, logger });
  const notifications = createNotificationsService({ pool, clock, logger });

  const auth = createAuthService({
    pool,
    clock,
    sessionTtlDays: config.SESSION_TTL_DAYS,
    audit,
    lockoutAttempts: config.LOGIN_LOCKOUT_ATTEMPTS,
    lockoutMinutes: config.LOGIN_LOCKOUT_MINUTES,
    mailer,
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
    mailer,
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
  // Exposed for main.ts (scheduling) and tests (running a pass on demand).
  app.decorate('maintenance', maintenance);

  registerSession(app, config, auth);

  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: both dependencies must actually answer, because compose gates the web
  // container on this.
  app.get('/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ error: { code: 'NOT_READY', message: 'Dependencies unavailable.' } });
    }
  });

  registerAuthRoutes(app, { config, auth });
  registerWorkspaceRoutes(app, { workspaces, overview });
  registerInvitationRoutes(app, { workspaces });
  registerDocumentRoutes(app, { config, documents, workspaces, shares });
  registerShareRoutes(app, { config, shares });
  registerFolderRoutes(app, { folders, workspaces });
  registerAuditRoutes(app, { audit, workspaces });
  registerNotificationRoutes(app, { notifications });

  return app;
}
