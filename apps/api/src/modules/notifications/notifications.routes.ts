import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireSession } from '../../plugins/session';
import type { NotificationsService } from './notifications.service';

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: { notifications: NotificationsService },
): void {
  const { notifications } = deps;

  // Polled by the web client roughly every 20 seconds. Both queries are index-only, so
  // this is cheaper than the connection management a websocket would need here.
  app.get('/api/notifications', { preHandler: requireSession }, async (request) => {
    const user = currentUser(request);
    return notifications.list(user.id);
  });

  app.post('/api/notifications/read', { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ id: z.string().uuid().optional() }).parse(request.body ?? {});
    const user = currentUser(request);
    // user_id is part of the UPDATE's WHERE clause, so this can only ever affect the
    // caller's own rows even if an arbitrary id is supplied.
    await notifications.markRead(user.id, body.id);
    return reply.status(204).send();
  });
}
