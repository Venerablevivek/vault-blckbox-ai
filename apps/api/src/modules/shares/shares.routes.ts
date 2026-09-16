import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireSession } from '../../plugins/session';
import type { SharesService, Visitor } from './shares.service';

/** Fastify is configured with trustProxy, so request.ip honours X-Forwarded-For. */
function visitorOf(request: FastifyRequest): Visitor {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export function registerShareRoutes(
  app: FastifyInstance,
  deps: { shares: SharesService },
): void {
  const { shares } = deps;

  app.post('/api/shares', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const body = z
        .object({
          documentId: z.string().uuid(),
          // null means "never expires"; omitted means "use the default".
          expiresInHours: z.number().int().positive().max(8760).nullable().optional(),
        })
        .parse(request.body);

      const user = currentUser(request);
      const result = await shares.create({
        documentId: body.documentId,
        userId: user.id,
        expiresInHours: body.expiresInHours,
      });

      // The plaintext token is returned exactly once, here. Only its hash is stored, so
      // it genuinely cannot be shown again — the UI says so.
      return reply.status(201).send({
        share: {
          id: result.share.id,
          url: result.url,
          expiresAt: result.share.expires_at,
          createdAt: result.share.created_at,
        },
      });
    },
  });

  // Access history for one link — the "who has seen my document?" view.
  app.get('/api/shares/:id/events', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = currentUser(request);
      return { events: await shares.listEvents(id, user.id) };
    },
  });

  app.delete('/api/shares/:id', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = currentUser(request);
      await shares.revoke(id, user.id);
      return reply.status(204).send();
    },
  });

  /**
   * Public routes. No session is read here at all.
   *
   * Rate limited hard: a 256-bit token is not brute-forceable, but the limit keeps the
   * logs readable and bounds automated probing.
   */
  app.get('/api/shares/:token', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.params);
      return shares.resolvePublic(token);
    },
  });

  // Page-view beacon, sent by the share page in the browser. 204 when counted (or ignored as
  // a repeat), 410/404 for dead or unknown links — dead-link attempts are still recorded.
  app.post('/api/shares/:token/view', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.params);
      await shares.recordView(token, visitorOf(request));
      return reply.status(204).send();
    },
  });

  app.get('/api/shares/:token/download', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.params);
      // Every rule is re-checked here; the previous metadata call is never trusted.
      const url = await shares.downloadUrl(token, visitorOf(request));
      return reply.redirect(url, 302);
    },
  });
}
