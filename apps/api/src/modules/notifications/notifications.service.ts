import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../../db/pool';
import type { JobPayloads, JobQueue } from '../../jobs/queue';
import type { Clock } from '../../types';
import { ESSENTIAL_TYPES, notificationsRepo, type NotificationType, type Preferences } from './notifications.repo';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { digestEmail, notificationEmail } from '../../mail/templates';
import { withTenant } from '../../db/tenant';

export interface NotifyInput {
  userId: string;
  workspaceId: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  resourceId?: string | null;
}

/** Notifications listed in one digest email; the rest are counted. */
const DIGEST_ITEMS = 20;

export function createNotificationsService(deps: {
  pool: Pool;
  clock: Clock;
  logger: Logger;
  jobs: JobQueue;
  webUrl: string;
}) {
  const { pool, clock, logger, jobs, webUrl } = deps;

  const linkFor = (workspaceId: string | null) => (workspaceId ? `${webUrl}/workspaces/${workspaceId}` : `${webUrl}/`);

  /**
   * Delivers one notification to each recipient as their preferences say. The two choices are
   * independent: it is shown in the app unless they muted its type (essential types can't be
   * muted), and emailed right away if they asked for that and their address is verified.
   */
  async function deliver(userIds: string[], input: Omit<NotifyInput, 'userId'>): Promise<void> {
    if (userIds.length === 0) return;
    const essential = ESSENTIAL_TYPES.includes(input.type);
    const delivery = await notificationsRepo.deliveryFor(pool, userIds, input.type);
    for (const userId of userIds) {
      const person = delivery.get(userId);
      if (!person) continue;
      if (essential || !person.muted) await notificationsRepo.insert(pool, row({ ...input, userId }));
      if (person.email) {
        await jobs.enqueue(
          pool,
          'email.send',
          notificationEmail({
            to: person.email,
            title: input.title,
            body: input.body ?? null,
            url: linkFor(input.workspaceId),
          }),
        );
      }
    }
  }

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
      void deliver([input.userId], input).catch((error: unknown) => {
        logger.warn({ err: error, type: input.type }, 'failed to write notification');
      });
    },

    /**
     * Notifies every member of a workspace except the person who caused the event. The fan-out
     * (one row per member, which can be thousands) runs as a job, enqueued with `db`: pass the
     * transaction of the event so the notification exists exactly when the event does.
     */
    async notifyWorkspace(
      db: Db,
      workspaceId: string,
      exceptUserId: string,
      input: Omit<NotifyInput, 'userId' | 'workspaceId'>,
    ): Promise<void> {
      await jobs.enqueue(db, 'notifications.fanout', {
        workspaceId,
        exceptUserId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        resourceId: input.resourceId ?? null,
      });
    },

    /** Job handler for notifications.fanout. Recipients are resolved when the job runs. */
    async fanOut(payload: JobPayloads['notifications.fanout']): Promise<void> {
      const recipients = await notificationsRepo.recipientsFor(pool, payload.workspaceId, payload.exceptUserId);
      await deliver(recipients, {
        workspaceId: payload.workspaceId,
        type: payload.type as NotificationType,
        title: payload.title,
        body: payload.body,
        resourceId: payload.resourceId,
      });
    },

    async getPreferences(userId: string) {
      return { ...(await notificationsRepo.preferences(pool, userId)), essential: [...ESSENTIAL_TYPES] };
    },

    async savePreferences(userId: string, preferences: Preferences) {
      const blocked = preferences.muted.filter((type) => ESSENTIAL_TYPES.includes(type));
      if (blocked.length > 0) {
        throw Errors.badRequest(
          'ESSENTIAL_NOTIFICATION',
          `These notifications can't be turned off: ${blocked.join(', ')}.`,
        );
      }
      const clean = {
        digest: preferences.digest,
        instant: [...new Set(preferences.instant)].sort(),
        muted: [...new Set(preferences.muted)].sort(),
      };
      await notificationsRepo.savePreferences(pool, userId, clean, clock.now());
      return { ...clean, essential: [...ESSENTIAL_TYPES] };
    },

    /**
     * Maintenance: emails a summary of unread notifications to everyone whose digest is due.
     * Nothing is sent to someone with nothing new. The email and the "sent" mark commit together,
     * so a failed run sends nothing twice.
     */
    async sendDigests(limit = 500): Promise<number> {
      const now = clock.now();
      let sent = 0;
      for (const person of await notificationsRepo.dueDigests(pool, now, limit)) {
        const delivered = await withTransaction(pool, async (tx) => {
          const items = await notificationsRepo.takeForDigest(tx, person.user_id, now);
          if (items.length === 0) return false; // nothing new: no email, and the clock isn't reset
          await jobs.enqueue(
            tx,
            'email.send',
            digestEmail({
              to: person.email,
              frequency: person.digest,
              items: items
                .slice(0, DIGEST_ITEMS)
                .map((n) => ({ title: n.title, workspace: n.workspace_name, at: n.created_at })),
              total: items.length,
              url: `${webUrl}/`,
            }),
          );
          await notificationsRepo.markDigestSent(tx, person.user_id, now);
          return true;
        });
        if (delivered) sent += 1;
      }
      return sent;
    },

    async list(userId: string, limit = 30) {
      const [rows, unread] = await withTenant(pool, userId, (db) =>
        Promise.all([
          notificationsRepo.listForUser(db, userId, Math.min(limit, 100)),
          notificationsRepo.unreadCount(db, userId),
        ]),
      );
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
