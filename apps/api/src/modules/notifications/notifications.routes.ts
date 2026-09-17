import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Config } from '../../config';
import { MarkReadBody } from '../../contracts/activity';
import { Errors } from '../../lib/errors';
import { currentUser, requireSession } from '../../plugins/session';
import type { AuthService } from '../auth/auth.service';
import type { NotificationStreamHub } from './notification-stream';
import type { NotificationsService } from './notifications.service';

/** Open event streams one person may hold at once (roughly: browser tabs). */
export const MAX_STREAMS_PER_USER = 5;

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: { config: Config; notifications: NotificationsService; hub: NotificationStreamHub; auth: AuthService },
): void {
  const { config, notifications, hub, auth } = deps;
  const open = new Set<ServerResponse>();

  app.get('/api/notifications', { preHandler: requireSession }, async (request) => {
    const user = currentUser(request);
    return notifications.list(user.id);
  });

  /**
   * Server-sent events: `event: notification` whenever the caller's inbox changes, so the bell
   * updates at once instead of on the next poll. Each event is only a signal; the client fetches
   * the notifications through GET /api/notifications, which applies the usual visibility rules.
   *
   * A comment line every NOTIFICATION_STREAM_HEARTBEAT_SECONDS keeps proxies from closing an idle
   * connection, and each heartbeat re-checks the session: signing out, or being signed out from
   * another device, ends the stream within one interval.
   */
  app.get('/api/notifications/stream', { preHandler: requireSession }, async (request, reply) => {
    const user = currentUser(request);
    if (hub.connectionsFor(user.id) >= MAX_STREAMS_PER_USER) {
      throw Errors.tooManyRequests(
        'STREAM_LIMIT',
        'Too many open notification streams. Close a tab and try again.',
        30,
      );
    }
    const token = request.cookies[config.SESSION_COOKIE_NAME]!;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: compression middleware must not buffer the stream.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    open.add(res);

    let ended = false;
    let unsubscribe = () => undefined as void;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
      res.end();
    };

    // Reconnect after 5 seconds if the connection drops; start by telling the client to sync.
    res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');
    const heartbeat = setInterval(() => {
      void auth
        .resolveSession(token)
        .then((session) => {
          if (!session || session.user.id !== user.id) return end();
          res.write(': keep-alive\n\n');
        })
        .catch(() => end());
    }, config.NOTIFICATION_STREAM_HEARTBEAT_SECONDS * 1000);

    unsubscribe = await hub.subscribe(user.id, () => {
      if (!ended) res.write('event: notification\ndata: {}\n\n');
    });
    request.raw.on('close', end);
    if (request.raw.destroyed) end();
  });

  app.post('/api/notifications/read', { preHandler: requireSession }, async (request, reply) => {
    const body = MarkReadBody.parse(request.body ?? {});
    const user = currentUser(request);
    // user_id is part of the UPDATE's WHERE clause, so this can only ever affect the
    // caller's own rows even if an arbitrary id is supplied.
    await notifications.markRead(user.id, body.id);
    return reply.status(204).send();
  });

  // Streams are hijacked from Fastify, so close them explicitly on shutdown.
  app.addHook('onClose', async () => {
    for (const res of open) res.end();
    open.clear();
    await hub.close();
  });
}
