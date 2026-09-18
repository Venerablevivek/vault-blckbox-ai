import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSV_BOM, csvRow } from '../../lib/csv';
import type { Config } from '../../config';
import {
  CreateShareBody,
  RequestCodeBody,
  ShareIdParams,
  ShareTokenParams,
  UnlockBody,
  UpdateShareBody,
  VerifyCodeBody,
} from '../../contracts/shares';
import { attachmentDisposition } from '../documents/documents.routes';
import { Errors } from '../../lib/errors';
import { currentUser, requireSession } from '../../plugins/session';
import { grantCookieName, type SharesService, type Visitor } from './shares.service';

/** request.ip honours X-Forwarded-For only from TRUSTED_PROXIES (see config.ts). */
function visitorOf(request: FastifyRequest): Visitor {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export function registerShareRoutes(app: FastifyInstance, deps: { config: Config; shares: SharesService }): void {
  const { config, shares } = deps;

  const grantOf = (request: FastifyRequest, token: string) => request.cookies[grantCookieName(token)];

  /** Stores an unlock grant (password and/or verified address) for this one link. */
  const setGrant = (reply: FastifyReply, token: string, result: { grant: string | null; maxAgeSeconds: number }) => {
    if (!result.grant) return;
    reply.setCookie(grantCookieName(token), result.grant, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.SESSION_COOKIE_SECURE,
      path: '/',
      maxAge: result.maxAgeSeconds,
    });
  };

  app.post('/api/shares', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const body = CreateShareBody.parse(request.body);
      const user = currentUser(request);
      // Share links reach people outside the platform, so the account must own its address first.
      if (!user.emailVerified) throw Errors.emailNotVerified('create share links');
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
          allowDownload: result.share.allow_download,
          allowedEmails: result.share.allowed_emails,
        },
      });
    },
  });

  app.patch('/api/shares/:id', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = ShareIdParams.parse(request.params);
      const user = currentUser(request);
      const changes = UpdateShareBody.parse(request.body);
      const share = await shares.update(id, user.id, changes);
      return {
        share: {
          id: share.id,
          expiresAt: share.expires_at,
          hasPassword: share.password_hash !== null,
          maxDownloads: share.max_downloads,
          downloadCount: share.download_count,
          allowDownload: share.allow_download,
          allowedEmails: share.allowed_emails,
        },
      };
    },
  });

  app.get('/api/shares/:id/events', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = ShareIdParams.parse(request.params);
      return { events: await shares.listEvents(id, currentUser(request).id) };
    },
  });

  // A link's full access history as CSV. The first event is read before the headers go out, so
  // a link the caller can't see is a proper 404 rather than a broken download.
  app.get('/api/shares/:id/events/export', {
    preHandler: requireSession,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { id } = ShareIdParams.parse(request.params);
      const events = shares.exportEvents(id, currentUser(request).id);
      const first = await events.next();
      async function* lines() {
        yield CSV_BOM + csvRow(['time_utc', 'outcome', 'viewer', 'email', 'user_agent']);
        for (let item = first; !item.done; item = await events.next()) {
          const e = item.value;
          yield csvRow([e.accessedAt.toISOString(), e.outcome, e.viewer, e.email, e.userAgent]);
        }
      }
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', attachmentDisposition(`link-activity-${id.slice(0, 8)}.csv`))
        .header('Cache-Control', 'private, no-store')
        .send(Readable.from(lines()));
    },
  });

  app.delete('/api/shares/:id', {
    preHandler: requireSession,
    handler: async (request, reply) => {
      const { id } = ShareIdParams.parse(request.params);
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
      const { token } = ShareTokenParams.parse(request.params);
      return shares.resolvePublic(token, grantOf(request, token), visitorOf(request));
    },
  });

  app.post('/api/shares/:token/unlock', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { password } = UnlockBody.parse(request.body);
      setGrant(reply, token, await shares.unlock(token, password, visitorOf(request), grantOf(request, token)));
      return reply.status(204).send();
    },
  });

  // Links restricted to named people: email a one-time code, then check it. The first always
  // answers 202, whether or not the address is on the link.
  app.post('/api/shares/:token/code', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { email } = RequestCodeBody.parse(request.body);
      await shares.requestCode(token, email, visitorOf(request));
      return reply.status(202).send({
        message: 'If that address can open this link, a code is on its way. It may take a minute to arrive.',
      });
    },
  });

  app.post('/api/shares/:token/verify', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const { email, code } = VerifyCodeBody.parse(request.body);
      setGrant(reply, token, await shares.verifyCode(token, email, code, visitorOf(request), grantOf(request, token)));
      return reply.status(204).send();
    },
  });

  // The file shown in the page. Only this site may frame it; it is never cached.
  app.get('/api/shares/:token/content', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const file = await shares.content(token, visitorOf(request), grantOf(request, token));
      return reply
        .header('Content-Type', file.contentType)
        .header('Content-Length', String(file.size))
        .header('Content-Disposition', attachmentDisposition(file.filename, 'inline'))
        .header('Cache-Control', 'private, no-store')
        .header('X-Frame-Options', 'SAMEORIGIN')
        .send(file.body);
    },
  });

  // Page-view beacon, sent by the share page from the recipient's browser.
  app.post('/api/shares/:token/view', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      await shares.recordView(token, visitorOf(request), grantOf(request, token));
      return reply.status(204).send();
    },
  });

  app.get('/api/shares/:token/download', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { token } = ShareTokenParams.parse(request.params);
      const url = await shares.downloadUrl(token, visitorOf(request), grantOf(request, token));
      return reply.redirect(url, 302);
    },
  });
}
