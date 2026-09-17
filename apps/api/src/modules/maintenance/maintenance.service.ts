import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '../../types';
import type { DocumentsService } from '../documents/documents.service';

/** Retention for housekeeping data. Deliberately conservative: nothing a user relies on. */
export const RETENTION = {
  /** Expired sessions are useless; kept a day only so a just-expired cookie still maps to a row in logs. */
  expiredSessionsDays: 1,
  /** Login failures only matter inside the lockout window. */
  loginFailuresDays: 1,
  /** Read notifications are clutter after a month; unread ones are kept longer. */
  readNotificationsDays: 30,
  anyNotificationsDays: 90,
  /** Expired invitations are kept a week past expiry so "this invitation expired" still resolves. */
  expiredInvitationsDays: 7,
};

/** Only one API instance runs cleanup at a time, even if several are deployed. */
const MAINTENANCE_LOCK_KEY = 8_273_461_210;

export function createMaintenanceService(deps: {
  pool: Pool;
  clock: Clock;
  logger: Logger;
  documents: DocumentsService;
}) {
  const { pool, clock, logger, documents } = deps;
  const daysAgo = (days: number) => new Date(clock.now().getTime() - days * 86_400_000);

  return {
    /**
     * One cleanup pass. Returns what it removed, for logs and tests.
     *
     * Skips (returns null) when another instance holds the advisory lock. Every step is
     * independent: a failure in one is logged and the rest still run.
     */
    async runOnce() {
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
          MAINTENANCE_LOCK_KEY,
        ]);
        if (!rows[0]?.locked) return null;

        const result = {
          expiredSessions: 0,
          loginFailures: 0,
          notifications: 0,
          expiredInvitations: 0,
          trashPurged: 0,
          trashFailed: 0,
          checksumsBackfilled: 0,
          workspacesPurged: 0,
        };

        const step = async (name: string, fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (error) {
            logger.error({ err: error, step: name }, 'maintenance step failed');
          }
        };

        await step('sessions', async () => {
          const r = await client.query('DELETE FROM sessions WHERE expires_at < $1', [
            daysAgo(RETENTION.expiredSessionsDays),
          ]);
          result.expiredSessions = r.rowCount ?? 0;
        });
        await step('login_failures', async () => {
          const r = await client.query('DELETE FROM login_failures WHERE failed_at < $1', [
            daysAgo(RETENTION.loginFailuresDays),
          ]);
          result.loginFailures = r.rowCount ?? 0;
        });
        await step('notifications', async () => {
          const r = await client.query(
            `DELETE FROM notifications
              WHERE (read_at IS NOT NULL AND created_at < $1) OR created_at < $2`,
            [daysAgo(RETENTION.readNotificationsDays), daysAgo(RETENTION.anyNotificationsDays)],
          );
          result.notifications = r.rowCount ?? 0;
        });
        await step('invitations', async () => {
          const r = await client.query('DELETE FROM invitations WHERE accepted_at IS NULL AND expires_at < $1', [
            daysAgo(RETENTION.expiredInvitationsDays),
          ]);
          result.expiredInvitations = r.rowCount ?? 0;
        });
        await step('trash', async () => {
          const r = await documents.purgeExpiredTrash();
          result.trashPurged = r.purged;
          result.trashFailed = r.failed;
        });

        await step('deleted_workspaces', async () => {
          const r = await documents.purgeDeletedWorkspaces();
          result.workspacesPurged = r.workspaces;
        });
        await step('checksums', async () => {
          const r = await documents.backfillChecksums();
          result.checksumsBackfilled = r.updated;
        });

        logger.info(result, 'maintenance pass complete');
        return result;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_KEY]).catch(() => undefined);
        client.release();
      }
    },

    /** Runs a pass every `minutes`, starting shortly after boot. Returns a stop function. */
    schedule(minutes: number): () => void {
      if (minutes <= 0) return () => undefined;
      const run = () =>
        void this.runOnce().catch((error: unknown) => logger.error({ err: error }, 'maintenance pass failed'));
      const first = setTimeout(run, 30_000);
      const timer = setInterval(run, minutes * 60_000);
      first.unref();
      timer.unref();
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
