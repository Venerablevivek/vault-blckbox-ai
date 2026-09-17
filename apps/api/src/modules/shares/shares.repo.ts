import type { Db } from '../../db/pool';

export type AccessOutcome =
  'resolved' | 'downloaded' | 'expired' | 'revoked' | 'document_deleted' | 'exhausted' | 'bad_password';

export interface ShareRow {
  id: string;
  document_id: string;
  expires_at: Date | null;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  password_hash: string | null;
  max_downloads: number | null;
  download_count: number;
}

export interface ShareState {
  id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  document_deleted_at: Date | null;
  max_downloads: number | null;
  download_count: number;
}

export interface ShareActivity {
  /** Page views, one per visitor per 30 minutes. */
  opens: number;
  /** Actual downloads. Counted separately so a view followed by a download is one open. */
  downloads: number;
  distinctViewers: number;
  firstAccessedAt: Date | null;
  lastAccessedAt: Date | null;
  blockedAttempts: number;
}

export interface ResolvedShare {
  share_id: string;
  document_id: string;
  workspace_id: string;
  created_by: string;
  filename: string;
  mime_type: string;
  size: string;
  storage_key: string;
  expires_at: Date | null;
  password_hash: string | null;
  max_downloads: number | null;
  download_count: number;
}

const SHARE_COLUMNS = `s.id, s.document_id, s.expires_at, s.created_by, s.created_at, s.revoked_at,
                       s.password_hash, s.max_downloads, s.download_count`;

export const sharesRepo = {
  async insert(
    db: Db,
    share: {
      id: string;
      documentId: string;
      tokenHash: Buffer;
      expiresAt: Date | null;
      createdBy: string;
      passwordHash: string | null;
      maxDownloads: number | null;
    },
  ): Promise<ShareRow> {
    const { rows } = await db.query<ShareRow>(
      `INSERT INTO shares AS s (id, document_id, token_hash, expires_at, created_by, password_hash, max_downloads)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SHARE_COLUMNS}`,
      [
        share.id,
        share.documentId,
        share.tokenHash,
        share.expiresAt,
        share.createdBy,
        share.passwordHash,
        share.maxDownloads,
      ],
    );
    return rows[0]!;
  },

  /**
   * Resolves a share token to its document, only while the link is usable.
   *
   * Every liveness rule is expressed in SQL: not revoked, not expired, download limit not
   * reached, and the document itself not in the trash. Nothing is cached, so a change to any
   * of these takes effect on the very next request.
   */
  async resolveLive(db: Db, tokenHash: Buffer, now: Date): Promise<ResolvedShare | null> {
    const { rows } = await db.query<ResolvedShare>(
      `SELECT s.id AS share_id, d.id AS document_id, d.workspace_id, s.created_by,
              d.filename, d.mime_type, d.size, d.storage_key, s.expires_at,
              s.password_hash, s.max_downloads, s.download_count
         FROM shares s
         JOIN documents d ON d.id = s.document_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > $2)
          AND (s.max_downloads IS NULL OR s.download_count < s.max_downloads)
          AND d.deleted_at IS NULL`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  /**
   * Looks up a token regardless of whether it is still usable: tells a dead link (410) from
   * one that never existed (404), and attaches the failed attempt to the right link.
   */
  async findStateByTokenHash(db: Db, tokenHash: Buffer): Promise<ShareState | null> {
    const { rows } = await db.query<ShareState>(
      `SELECT s.id, s.revoked_at, s.expires_at, d.deleted_at AS document_deleted_at,
              s.max_downloads, s.download_count
         FROM shares s
         JOIN documents d ON d.id = s.document_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },

  /**
   * Claims one download against the link's limit, atomically.
   *
   * The limit check and the increment are one conditional UPDATE, so two simultaneous
   * downloads of a one-time link cannot both succeed: the second matches no row.
   */
  async claimDownload(db: Db, shareId: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE shares SET download_count = download_count + 1
        WHERE id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $2)
          AND (max_downloads IS NULL OR download_count < max_downloads)`,
      [shareId, now],
    );
    return (rowCount ?? 0) > 0;
  },

  /** Recent wrong-password attempts on one link, for per-link lockout. */
  async recentBadPasswords(db: Db, shareId: string, since: Date): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM share_access_events
        WHERE share_id = $1 AND outcome = 'bad_password' AND accessed_at > $2`,
      [shareId, since],
    );
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Records one access. Fire-and-forget at the call site: a failure to write telemetry must
   * never stop someone downloading a document they are entitled to.
   */
  async recordAccess(
    db: Db,
    event: { id: string; shareId: string; ipHash: Buffer; userAgent: string | null; outcome: AccessOutcome; at: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO share_access_events (id, share_id, accessed_at, ip_hash, user_agent, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, event.shareId, event.at, event.ipHash, event.userAgent, event.outcome],
    );
  },

  /**
   * Activity rollup for a set of links, in one query rather than N. "Distinct viewers" counts
   * distinct hashed addresses, which is an estimate and is labelled as one in the UI.
   */
  async activityFor(db: Db, shareIds: string[]): Promise<Map<string, ShareActivity>> {
    if (shareIds.length === 0) return new Map();
    const { rows } = await db.query<{
      share_id: string;
      opens: string;
      downloads: string;
      viewers: string;
      first_at: Date | null;
      last_at: Date | null;
      blocked: string;
    }>(
      `SELECT share_id,
              COUNT(*)                FILTER (WHERE outcome = 'resolved') AS opens,
              COUNT(*)                FILTER (WHERE outcome = 'downloaded') AS downloads,
              COUNT(DISTINCT ip_hash) FILTER (WHERE outcome IN ('resolved','downloaded')) AS viewers,
              MIN(accessed_at)        FILTER (WHERE outcome IN ('resolved','downloaded')) AS first_at,
              MAX(accessed_at)        FILTER (WHERE outcome IN ('resolved','downloaded')) AS last_at,
              COUNT(*)                FILTER (WHERE outcome NOT IN ('resolved','downloaded')) AS blocked
         FROM share_access_events
        WHERE share_id = ANY($1::uuid[])
        GROUP BY share_id`,
      [shareIds],
    );
    return new Map(
      rows.map((r) => [
        r.share_id,
        {
          opens: Number(r.opens),
          downloads: Number(r.downloads),
          distinctViewers: Number(r.viewers),
          firstAccessedAt: r.first_at,
          lastAccessedAt: r.last_at,
          blockedAttempts: Number(r.blocked),
        },
      ]),
    );
  },

  /** Has this viewer opened this link before? Decides whether the sender hears about it. */
  async hasSeenViewer(db: Db, shareId: string, ipHash: Buffer): Promise<boolean> {
    const { rowCount } = await db.query(
      `SELECT 1 FROM share_access_events
        WHERE share_id = $1 AND ip_hash = $2 AND outcome IN ('resolved','downloaded')
        LIMIT 1`,
      [shareId, ipHash],
    );
    return (rowCount ?? 0) > 0;
  },

  /** Has this visitor viewed the link since `since`? Backs the refresh de-duplication. */
  async hasRecentView(db: Db, shareId: string, ipHash: Buffer, since: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `SELECT 1 FROM share_access_events
        WHERE share_id = $1 AND ip_hash = $2 AND outcome = 'resolved' AND accessed_at > $3
        LIMIT 1`,
      [shareId, ipHash, since],
    );
    return (rowCount ?? 0) > 0;
  },

  async distinctViewerCount(db: Db, shareId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT ip_hash) AS count FROM share_access_events
        WHERE share_id = $1 AND outcome IN ('resolved','downloaded')`,
      [shareId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  async listEvents(db: Db, shareId: string, limit = 20) {
    const { rows } = await db.query<{
      accessed_at: Date;
      outcome: AccessOutcome;
      user_agent: string | null;
      ip_hash: Buffer;
    }>(
      `SELECT accessed_at, outcome, user_agent, ip_hash FROM share_access_events
        WHERE share_id = $1 ORDER BY accessed_at DESC LIMIT $2`,
      [shareId, limit],
    );
    return rows;
  },

  async findById(db: Db, id: string): Promise<(ShareRow & { workspace_id: string }) | null> {
    const { rows } = await db.query<ShareRow & { workspace_id: string }>(
      `SELECT ${SHARE_COLUMNS}, d.workspace_id
         FROM shares s JOIN documents d ON d.id = s.document_id
        WHERE s.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async listForDocument(db: Db, documentId: string): Promise<ShareRow[]> {
    const { rows } = await db.query<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM shares s
        WHERE s.document_id = $1 AND s.revoked_at IS NULL
        ORDER BY s.created_at DESC`,
      [documentId],
    );
    return rows;
  },

  /**
   * Updates a link's settings. `undefined` leaves a field unchanged; `null` clears it
   * (no expiry, no password, no download limit).
   */
  async updateSettings(
    db: Db,
    id: string,
    changes: { expiresAt?: Date | null; passwordHash?: string | null; maxDownloads?: number | null },
  ): Promise<ShareRow> {
    const { rows } = await db.query<ShareRow>(
      `UPDATE shares AS s
          SET expires_at    = CASE WHEN $2 THEN $3::timestamptz ELSE expires_at END,
              password_hash = CASE WHEN $4 THEN $5::text ELSE password_hash END,
              max_downloads = CASE WHEN $6 THEN $7::integer ELSE max_downloads END
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING ${SHARE_COLUMNS}`,
      [
        id,
        changes.expiresAt !== undefined,
        changes.expiresAt ?? null,
        changes.passwordHash !== undefined,
        changes.passwordHash ?? null,
        changes.maxDownloads !== undefined,
        changes.maxDownloads ?? null,
      ],
    );
    return rows[0]!;
  },

  async revoke(db: Db, id: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(`UPDATE shares SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [
      id,
      now,
    ]);
    return (rowCount ?? 0) > 0;
  },

  /** Revokes every live link to a document. Used when the document goes to the trash. */
  async revokeForDocument(db: Db, documentId: string, now: Date): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE shares SET revoked_at = $2 WHERE document_id = $1 AND revoked_at IS NULL`,
      [documentId, now],
    );
    return rowCount ?? 0;
  },

  /**
   * Revokes every live link a person created in a workspace. Used when they are removed or
   * downgraded to VIEWER, so links they handed out stop working when their access ends.
   */
  async revokeCreatedByInWorkspace(db: Db, workspaceId: string, userId: string, now: Date): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE shares s SET revoked_at = $3
         FROM documents d
        WHERE d.id = s.document_id
          AND d.workspace_id = $1
          AND s.created_by = $2
          AND s.revoked_at IS NULL`,
      [workspaceId, userId, now],
    );
    return rowCount ?? 0;
  },
};
