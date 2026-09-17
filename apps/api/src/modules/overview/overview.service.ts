import type { Pool } from 'pg';
import type { Clock, Role } from '../../types';
import type { AuditService } from '../audit/audit.service';

/** Days shown in the dashboard's activity charts. */
const SERIES_DAYS = 14;

/**
 * Groups MIME types into the handful of buckets a person thinks in. Done in SQL with the
 * same rules, so the chart and any future report cannot disagree.
 */
const CATEGORY_SQL = `
  CASE
    WHEN mime_type = 'application/pdf' THEN 'PDF'
    WHEN mime_type LIKE 'image/%' THEN 'Images'
    WHEN mime_type IN ('application/vnd.ms-excel',
                       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                       'text/csv') THEN 'Spreadsheets'
    WHEN mime_type IN ('application/msword',
                       'application/vnd.openxmlformats-officedocument.wordprocessingml.document') THEN 'Documents'
    WHEN mime_type IN ('application/vnd.ms-powerpoint',
                       'application/vnd.openxmlformats-officedocument.presentationml.presentation') THEN 'Presentations'
    ELSE 'Text & other'
  END`;

/**
 * Accepts an IANA time zone only if PostgreSQL knows it, otherwise falls back to UTC.
 * The list is loaded once; the zone is always passed as a bound parameter, never spliced in.
 */
let knownZones: Promise<Set<string>> | null = null;

export function createOverviewService(deps: { pool: Pool; clock: Clock; audit: AuditService }) {
  const { pool, clock, audit } = deps;

  async function resolveTimeZone(requested: string): Promise<string> {
    knownZones ??= pool
      .query<{ name: string }>('SELECT name FROM pg_timezone_names')
      .then((r) => new Set(r.rows.map((row) => row.name)))
      .catch((error: unknown) => {
        knownZones = null;
        throw error;
      });
    return (await knownZones).has(requested) ? requested : 'UTC';
  }

  return {
    /**
     * Everything the workspace dashboard shows, in one round trip.
     *
     * Every query is scoped by workspace_id and filters soft-deleted documents. The recent
     * activity feed is included only for owners — the same rule as the full audit trail,
     * because it carries the same information.
     */
    async forWorkspace(workspaceId: string, role: Role, timeZone = 'UTC') {
      const now = clock.now();
      const tz = await resolveTimeZone(timeZone);

      const [totals, byType, uploads, opens, topShared, recent, activity] = await Promise.all([
        pool.query<{
          documents: string;
          bytes: string;
          members: string;
          live_links: string;
          opens: string;
          pending_invites: string;
          storage_used: string;
          storage_quota: string;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL) AS documents,
             (SELECT COALESCE(SUM(size), 0) FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL) AS bytes,
             (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1) AS members,
             (SELECT COUNT(*) FROM shares s JOIN documents d ON d.id = s.document_id
                WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND s.revoked_at IS NULL
                  AND (s.expires_at IS NULL OR s.expires_at > $2)) AS live_links,
             (SELECT COUNT(*) FROM share_access_events e
                JOIN shares s ON s.id = e.share_id JOIN documents d ON d.id = s.document_id
                WHERE d.workspace_id = $1 AND e.outcome = 'resolved') AS opens,
             (SELECT COUNT(*) FROM invitations
                WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > $2) AS pending_invites,
             (SELECT storage_used_bytes FROM workspaces WHERE id = $1) AS storage_used,
             (SELECT storage_quota_bytes FROM workspaces WHERE id = $1) AS storage_quota`,
          [workspaceId, now],
        ),
        pool.query<{ category: string; count: string; bytes: string }>(
          `SELECT ${CATEGORY_SQL} AS category, COUNT(*) AS count, SUM(size) AS bytes
             FROM documents
            WHERE workspace_id = $1 AND deleted_at IS NULL
            GROUP BY 1
            ORDER BY SUM(size) DESC`,
          [workspaceId],
        ),
        // Days are calendar days in the viewer's time zone, not UTC: an upload at 11pm in
        // New York belongs to that evening, not to "tomorrow". generate_series fills empty
        // days with zero, so the chart never skips a day.
        pool.query<{ day: string; count: string }>(
          `WITH days AS (
             SELECT generate_series(($2::timestamptz AT TIME ZONE $3)::date - ${SERIES_DAYS - 1},
                                    ($2::timestamptz AT TIME ZONE $3)::date,
                                    interval '1 day')::date AS day
           )
           SELECT to_char(days.day, 'YYYY-MM-DD') AS day, COUNT(doc.id) AS count
             FROM days
             LEFT JOIN documents doc
               ON doc.workspace_id = $1 AND (doc.created_at AT TIME ZONE $3)::date = days.day
            GROUP BY days.day ORDER BY days.day`,
          [workspaceId, now, tz],
        ),
        pool.query<{ day: string; count: string }>(
          `WITH days AS (
             SELECT generate_series(($2::timestamptz AT TIME ZONE $3)::date - ${SERIES_DAYS - 1},
                                    ($2::timestamptz AT TIME ZONE $3)::date,
                                    interval '1 day')::date AS day
           )
           SELECT to_char(days.day, 'YYYY-MM-DD') AS day, COUNT(e.id) AS count
             FROM days
             LEFT JOIN (
               SELECT e.id, e.accessed_at FROM share_access_events e
                 JOIN shares s ON s.id = e.share_id
                 JOIN documents doc ON doc.id = s.document_id
                WHERE doc.workspace_id = $1 AND e.outcome = 'resolved'
             ) e ON (e.accessed_at AT TIME ZONE $3)::date = days.day
            GROUP BY days.day ORDER BY days.day`,
          [workspaceId, now, tz],
        ),
        pool.query<{ id: string; filename: string; mime_type: string; opens: string; viewers: string; last_at: Date | null }>(
          `SELECT d.id, d.filename, d.mime_type,
                  COUNT(e.id) FILTER (WHERE e.outcome = 'resolved') AS opens,
                  COUNT(DISTINCT e.ip_hash) AS viewers,
                  MAX(e.accessed_at) AS last_at
             FROM documents d
             JOIN shares s ON s.document_id = d.id
             JOIN share_access_events e ON e.share_id = s.id AND e.outcome IN ('resolved','downloaded')
            WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
            GROUP BY d.id
            HAVING COUNT(e.id) FILTER (WHERE e.outcome = 'resolved') > 0
            ORDER BY COUNT(e.id) FILTER (WHERE e.outcome = 'resolved') DESC
            LIMIT 5`,
          [workspaceId],
        ),
        pool.query<{ id: string; filename: string; mime_type: string; size: string; created_at: Date; email: string }>(
          `SELECT d.id, d.filename, d.mime_type, d.size, d.created_at, u.email
             FROM documents d JOIN users u ON u.id = d.uploaded_by
            WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
            ORDER BY d.created_at DESC LIMIT 5`,
          [workspaceId],
        ),
        role === 'OWNER' ? audit.list(workspaceId, { limit: 8 }) : Promise.resolve(null),
      ]);

      const t = totals.rows[0]!;
      return {
        totals: {
          documents: Number(t.documents),
          bytes: Number(t.bytes),
          members: Number(t.members),
          liveLinks: Number(t.live_links),
          opens: Number(t.opens),
          pendingInvites: Number(t.pending_invites),
        },
        // Includes trashed files: their bytes are still stored until the trash is emptied.
        storage: { usedBytes: Number(t.storage_used), quotaBytes: Number(t.storage_quota) },
        storageByType: byType.rows.map((r) => ({
          category: r.category,
          count: Number(r.count),
          bytes: Number(r.bytes),
        })),
        series: uploads.rows.map((r, i) => ({
          day: r.day,
          uploads: Number(r.count),
          opens: Number(opens.rows[i]?.count ?? 0),
        })),
        topShared: topShared.rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          mimeType: r.mime_type,
          opens: Number(r.opens),
          viewers: Number(r.viewers),
          lastAccessedAt: r.last_at,
        })),
        recentDocuments: recent.rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          mimeType: r.mime_type,
          size: Number(r.size),
          createdAt: r.created_at,
          uploadedByEmail: r.email,
        })),
        // null (not []) for members: "you can't see this" is different from "nothing happened".
        recentActivity: activity,
      };
    },
  };
}

export type OverviewService = ReturnType<typeof createOverviewService>;
