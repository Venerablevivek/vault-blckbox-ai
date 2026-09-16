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

export function createOverviewService(deps: { pool: Pool; clock: Clock; audit: AuditService }) {
  const { pool, clock, audit } = deps;

  return {
    /**
     * Everything the workspace dashboard shows, in one round trip.
     *
     * Every query is scoped by workspace_id and filters soft-deleted documents. The recent
     * activity feed is included only for owners — the same rule as the full audit trail,
     * because it carries the same information.
     */
    async forWorkspace(workspaceId: string, role: Role) {
      const now = clock.now();
      const since = new Date(now.getTime() - (SERIES_DAYS - 1) * 86_400_000);
      since.setUTCHours(0, 0, 0, 0);

      const [totals, byType, uploads, opens, topShared, recent, activity] = await Promise.all([
        pool.query<{
          documents: string;
          bytes: string;
          members: string;
          live_links: string;
          opens: string;
          pending_invites: string;
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
                WHERE d.workspace_id = $1 AND e.outcome IN ('resolved','downloaded')) AS opens,
             (SELECT COUNT(*) FROM invitations
                WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > $2) AS pending_invites`,
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
        // generate_series fills empty days with zero, so the chart never skips a day.
        pool.query<{ day: string; count: string }>(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(doc.id) AS count
             FROM generate_series($2::date, $3::date, interval '1 day') AS d(day)
             LEFT JOIN documents doc
               ON doc.workspace_id = $1 AND doc.created_at::date = d.day::date
            GROUP BY d.day ORDER BY d.day`,
          [workspaceId, since, now],
        ),
        pool.query<{ day: string; count: string }>(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(e.id) AS count
             FROM generate_series($2::date, $3::date, interval '1 day') AS d(day)
             LEFT JOIN (
               SELECT e.id, e.accessed_at FROM share_access_events e
                 JOIN shares s ON s.id = e.share_id
                 JOIN documents doc ON doc.id = s.document_id
                WHERE doc.workspace_id = $1 AND e.outcome IN ('resolved','downloaded')
             ) e ON e.accessed_at::date = d.day::date
            GROUP BY d.day ORDER BY d.day`,
          [workspaceId, since, now],
        ),
        pool.query<{ id: string; filename: string; mime_type: string; opens: string; viewers: string; last_at: Date | null }>(
          `SELECT d.id, d.filename, d.mime_type,
                  COUNT(e.id) AS opens,
                  COUNT(DISTINCT e.ip_hash) AS viewers,
                  MAX(e.accessed_at) AS last_at
             FROM documents d
             JOIN shares s ON s.document_id = d.id
             JOIN share_access_events e ON e.share_id = s.id AND e.outcome IN ('resolved','downloaded')
            WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
            GROUP BY d.id
            ORDER BY COUNT(e.id) DESC
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
