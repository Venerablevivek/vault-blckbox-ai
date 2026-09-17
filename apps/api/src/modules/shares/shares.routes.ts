import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import { currentUser, requireSession } from '../../plugins/session';
import { grantCookieName, type SharesService, type Visitor } from './shares.service';

/** request.ip honours X-Forwarded-For only from TRUSTED_PROXIES (see config.ts). */
function visitorOf(request: FastifyRequest): Visitor {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const tokenParams = z.object({ token: z.string().min(10).max(200) });

const linkSettings = {
  // null = never expires; omitted = the default (on create) or unchanged (on edit).
  expiresInHours: z.number().int().positive().max(8760).nullable().optional(),
  // null = remove the password.
  password: z.string().min(6).max(128).nullable().optional(),
  // null = unlimited; 1 = a one-time link.
  maxDownloads: z.number().int().min(1).max(1000).nullable().optional(),
};

export function registerShareRoutes(
  app: FastifyInstance,
  deps: { config: Config; shares: SharesService },
): void {
  const { config, shares } = deps;

  const grantOf = (request: FastifyRequest, token: string) => request.cookies[grantCookieName(token)];

  app.post('/api/shares', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const body = z.object({ documentId: z.string().uuid(), ...linkSettings }).parse(request.body);
      const user = currentUser(request);
      const result = await shares.create({ ...body, userId: user.id });

      // The plaintext token is returned exactly once, here. Only its hash is stored.
      return reply.status(201).send({
        share: {
          id: result.share.id,
          url: result.url,
          expiresAt: result.share.expires_at,
          createdAt: result.share.created_at,
          hasPassword: result.share.password_hash !== null,
          maxDownloads: result.share.max_downloads,
        },
      });
    },
  });

  app.patch('/api/shares/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = currentUser(request);
      const changes = z.object(linkSettings).parse(request.body);
      const share = await shares.update(id, user.id, changes);
      return {
        share: {
          id: share.id,
          expiresAt: share.expires_at,
          hasPassword: share.password_hash !== null,
          maxDownloads: share.max_downloads,
          downloadCount: share.download_count,
        },
      };
    },
  });

  app.get('/api/shares/:id/events', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return { events: await shares.listEvents(id, currentUser(request).id) };
    },
  });

  app.delete('/api/shares/:id', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await shares.revoke(id, currentUser(request).id);
      return reply.status(204).send();
    },
  });

  /*
   * Public routes: no session is required. Each is rate limited per client IP; password
   * guessing is additionally limited per link inside the service.
   */

  // Metadata for the share page. Called by the web server during render, twice per page
  // view (once for the HTTP status, once for the content), hence the higher limit.
  app.get('/api/shares/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { token } = tokenParams.parse(request.params);
      return shares.resolvePublic(token, grantOf(request, token));
    },
  });

  app.post('/api/shares/:token/unlock', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const { token } = tokenParams.parse(request.params);
      const { password } = z.object({ password: z.string().min(1).max(128) }).parse(request.body);
      const result = await shares.unlock(token, password, visitorOf(request));
      if (result.grant) {
        reply.setCookie(grantCookieName(token), result.grant, {
          httpOnly: true,
          sameSite: 'lax',
          secure: config.SESSION_COOKIE_SECURE,
          path: '/',
          maxAge: result.maxAgeSeconds,
        });
      }
      return reply.status(204).send();
    },
  });

  // Page-view beacon, sent by the share page from the recipient's browser.
  app.post('/api/shares/:token/view', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = tokenParams.parse(request.params);
      await shares.recordView(token, visitorOf(request), grantOf(request, token));
      return reply.status(204).send();
    },
  });

  app.get('/api/shares/:token/download', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = tokenParams.parse(request.params);
      const url = await shares.downloadUrl(token, visitorOf(request), grantOf(request, token));
      return reply.redirect(url, 302);
    },
  });
}
