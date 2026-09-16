import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '../../types';
import { notificationsRepo, type NotificationType } from './notifications.repo';

export interface NotifyInput {
  userId: string;
  workspaceId: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  resourceId?: string | null;
}

export function createNotificationsService(deps: {
  pool: Pool;
  clock: Clock;
  logger: Logger;
}) {
  const { pool, clock, logger } = deps;

  function row(input: NotifyInput) {
    return {
      id: randomUUID(),
      userId: input.userId,
      workspaceId: input.workspaceId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      resourceId: input.resourceId ?? null,
      at: clock.now(),
    };
  }

  return {
    /**
     * Notifications are always fire-and-forget.
     *
     * Nothing a user is entitled to do should fail because we could not tell someone else
     * about it. A dropped notification is a minor loss; a failed upload because of one is
     * not acceptable.
     */
    notify(input: NotifyInput): void {
      void notificationsRepo.insert(pool, row(input)).catch((error: unknown) => {
        logger.warn({ err: error, type: input.type }, 'failed to write notification');
      });
    },

    /** Notifies every member of a workspace except the person who caused the event. */
    notifyWorkspace(
      workspaceId: string,
      exceptUserId: string,
      input: Omit<NotifyInput, 'userId' | 'workspaceId'>,
    ): void {
      void (async () => {
        const recipients = await notificationsRepo.recipientsFor(pool, workspaceId, exceptUserId);
        for (const userId of recipients) {
          await notificationsRepo.insert(pool, row({ ...input, userId, workspaceId }));
        }
      })().catch((error: unknown) => {
        logger.warn({ err: error, type: input.type }, 'failed to fan out notification');
      });
    },

    async list(userId: string, limit = 30) {
      const [rows, unread] = await Promise.all([
        notificationsRepo.listForUser(pool, userId, Math.min(limit, 100)),
        notificationsRepo.unreadCount(pool, userId),
      ]);
      return {
        unread,
        notifications: rows.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          workspaceId: n.workspace_id,
          resourceId: n.resource_id,
          read: n.read_at !== null,
          createdAt: n.created_at,
        })),
      };
    },

    async markRead(userId: string, id?: string): Promise<void> {
      await notificationsRepo.markRead(pool, userId, clock.now(), id);
    },
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
