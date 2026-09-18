import type { Pool } from 'pg';
import { jobsRepo } from '../../jobs/jobs.repo';
import { sharesRepo } from '../shares/shares.repo';
import type { Logger } from 'pino';
import type { Clock } from '../../types';
import type { DocumentsService } from '../documents/documents.service';
import type { UploadsService } from '../uploads/uploads.service';

/** Retention for housekeeping data. Deliberately conservative: nothing a user relies on. */
export const RETENTION = {
  /** Expired sessions are useless; kept a day only so a just-expired cookie still maps to a row in logs. */
  expiredSessionsDays: 1,
  /** Login failures only matter inside the lockout window. */
  loginFailuresDays: 1,
  /** One-time share codes last ten minutes; a day covers any clock skew and debugging. */
  shareCodesDays: 1,
  /** Read notifications are clutter after a month; unread ones are kept longer. */
  readNotificationsDays: 30,
  anyNotificationsDays: 90,
  /** Expired invitations are kept a week past expiry so "this invitation expired" still resolves. */
  expiredInvitationsDays: 7,
  /** Months of share-event partitions created ahead of time. */
  eventPartitionsAhead: 3,
  /** Completed jobs are only useful for recent debugging. */
  finishedJobsDays: 7,
  /** Failed (dead-letter) jobs are kept longer, for someone to look into. */
  failedJobsDays: 30,
};

/** Only one API instance runs cleanup at a time, even if several are deployed. */
const MAINTENANCE_LOCK_KEY = 8_273_461_210;

export function createMaintenanceService(deps: {
  pool: Pool;
  clock: Clock;
  logger: Logger;
  documents: DocumentsService;
  uploads: UploadsService | null;
  shareEventRetentionMonths: number;
}) {
  const { pool, clock, logger, documents, uploads, shareEventRetentionMonths } = deps;
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
          finishedJobs: 0,
          droppedEventPartitions: [] as string[],
          expiredUploads: 0,
          rateLimitRows: 0,
          requeuedScans: 0,
          shareCodes: 0,
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
        await step('share_codes', async () => {
          const r = await client.query('DELETE FROM share_email_codes WHERE expires_at < $1', [
            daysAgo(RETENTION.shareCodesDays),
          ]);
          result.shareCodes = r.rowCount ?? 0;
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
        await step('rate_limits', async () => {
          // Windows that ended are dead weight; the next request starts a new one either way.
          const r = await client.query('DELETE FROM rate_limits WHERE window_ends_at < now()');
          result.rateLimitRows = r.rowCount ?? 0;
        });
        await step('uploads', async () => {
          if (uploads) result.expiredUploads = (await uploads.expireStale()).expired;
        });
        await step('share_event_partitions', async () => {
          result.droppedEventPartitions = await sharesRepo.maintainEventPartitions(
            client,
            clock.now(),
            RETENTION.eventPartitionsAhead,
            shareEventRetentionMonths,
          );
        });
        await step('jobs', async () => {
          result.finishedJobs = await jobsRepo.deleteFinished(
            client,
            daysAgo(RETENTION.finishedJobsDays),
            daysAgo(RETENTION.failedJobsDays),
          );
        });
        await step('scans', async () => {
          result.requeuedScans = await documents.requeuePendingScans();
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
  };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
