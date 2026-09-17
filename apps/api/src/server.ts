import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './plugins/errors';
import { createPgRateLimitStore } from './plugins/rate-limit-store';
import { registerSession } from './plugins/session';
import { registerAuthRoutes } from './modules/auth/auth.routes';
import { registerInvitationRoutes, registerWorkspaceRoutes } from './modules/workspaces/workspaces.routes';
import { registerDocumentRoutes } from './modules/documents/documents.routes';
import { registerShareRoutes } from './modules/shares/shares.routes';
import { registerAuditRoutes } from './modules/audit/audit.routes';
import { createNotificationStreamHub } from './modules/notifications/notification-stream';
import { registerNotificationRoutes } from './modules/notifications/notifications.routes';
import { registerFolderRoutes } from './modules/folders/folders.routes';
import { registerUploadRoutes } from './modules/uploads/uploads.routes';
import { LogMailer, SmtpMailer } from './mail/mailer';
import { buildOpenApiDocument } from './openapi/document';
import { createJobHandlers } from './jobs/handlers';
import { createServices } from './services';
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
    // /api/v1/* is the stable, versioned address for the same routes. Rewriting keeps one set of
    // handlers; a future v2 would register its own routes rather than change these.
    rewriteUrl: (request) => {
      const url = request.url ?? '/';
      return url.startsWith('/api/v1/') ? `/api/${url.slice('/api/v1/'.length)}` : url;
    },
  });

  // Every registered route, so a contract test can check the OpenAPI document covers them all.
  const routeTable: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', (route) => {
    for (const method of ([] as string[]).concat(route.method)) {
      if (method !== 'HEAD') routeTable.push({ method, url: route.url });
    }
  });
  app.decorate('routeTable', routeTable);

  await app.register(helmet, {
    // The API serves JSON and redirects only; it never renders HTML.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie);
  // Rate limiting is per-route (`config.rateLimit`), so a document listing is not
  // throttled like a login attempt. Counters are kept in PostgreSQL, shared by every API
  // instance and kept across restarts.
  //
  // It is off by default under NODE_ENV=test: every request in the suite comes from the same
  // address, so the limiter would throttle the tests rather than the attack it is there to stop.
  // The limiter's own tests turn it on (RATE_LIMIT_ENABLED=true). Route-level `config.rateLimit`
  // is ignored when the plugin is absent.
  if (config.RATE_LIMIT_ENABLED ?? config.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      global: false,
      max: 100,
      timeWindow: '1 minute',
      ...(config.RATE_LIMIT_STORE === 'postgres' ? { store: createPgRateLimitStore(pool, config.IP_HASH_PEPPER) } : {}),
    });
  }
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
  });

  registerErrorHandler(app);

  const services = createServices({
    config,
    pool,
    directPool: deps.directPool,
    readPool: deps.readPool,
    storage,
    multipartStorage: deps.multipartStorage ?? null,
    logger,
    clock,
  });
  const { auth, workspaces, documents, shares, overview, folders, maintenance, audit, notifications, jobs } = services;
  // Exposed for tests: running a maintenance pass and background jobs on demand.
  app.decorate('maintenance', maintenance);
  app.decorate('services', services);
  app.decorate('jobHandlers', createJobHandlers(services, mailer));
  void jobs;

  registerSession(app, config, auth);

  app.get('/health', async () => ({ status: 'ok' }));

  // The API contract, generated from the same Zod schemas the routes validate with.
  const openApiDocument = buildOpenApiDocument();
  app.get('/api/openapi.json', async () => openApiDocument);

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
  registerUploadRoutes(app, { uploads: services.uploads, workspaces });
  registerAuditRoutes(app, { audit, workspaces });
  registerNotificationRoutes(app, {
    config,
    notifications,
    auth,
    hub: createNotificationStreamHub({ pool: services.pools.directPool, logger }),
  });

  return app;
}
