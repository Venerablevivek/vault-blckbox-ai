import type { Db } from '../../db/pool';

export type AccessOutcome =
  'resolved' | 'downloaded' | 'expired' | 'revoked' | 'document_deleted' | 'exhausted' | 'bad_password' | 'bad_code';

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
  /** False for a view-only link. */
  allow_download: boolean;
  /** Addresses that may open the link; empty means anyone with the link. Stored lower-case. */
  allowed_emails: string[];
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
  allow_download: boolean;
  allowed_emails: string[];
}

export interface EmailCodeRow {
  id: string;
  code_hash: Buffer;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
}

const SHARE_COLUMNS = `s.id, s.document_id, s.expires_at, s.created_by, s.created_at, s.revoked_at,
                       s.password_hash, s.max_downloads, s.download_count, s.allow_download, s.allowed_emails`;

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
      allowDownload: boolean;
      allowedEmails: string[];
    },
  ): Promise<ShareRow> {
    const { rows } = await db.query<ShareRow>(
      `INSERT INTO shares AS s (id, document_id, token_hash, expires_at, created_by, password_hash, max_downloads,
                                allow_download, allowed_emails)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SHARE_COLUMNS}`,
      [
        share.id,
        share.documentId,
        share.tokenHash,
        share.expiresAt,
        share.createdBy,
        share.passwordHash,
        share.maxDownloads,
        share.allowDownload,
        share.allowedEmails,
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
              s.password_hash, s.max_downloads, s.download_count, s.allow_download, s.allowed_emails
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
   * Makes sure the monthly partition for `at` exists. Idempotent; the service calls it once per
   * month per process before writing an event, and the maintenance pass keeps months ahead ready.
   */
  async ensureEventPartition(db: Db, at: Date): Promise<void> {
    await db.query('SELECT ensure_share_event_partitions($1, 1)', [at]);
  },

  /** Appends one row to the (partitioned) access history. */
  async insertEvent(
    db: Db,
    event: {
      id: string;
      shareId: string;
      ipHash: Buffer;
      userAgent: string | null;
      outcome: AccessOutcome;
      at: Date;
      viewerEmail?: string | null;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO share_access_events (id, share_id, accessed_at, ip_hash, user_agent, outcome, viewer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, event.shareId, event.at, event.ipHash, event.userAgent, event.outcome, event.viewerEmail ?? null],
    );
  },

  /**
   * Records that a viewer opened the link, unless the same viewer already did within the
   * de-duplication window. One atomic upsert: two tabs refreshing at once still count once.
   * Returns null when de-duplicated, otherwise whether this viewer is new to the link.
   */
  async upsertViewerForView(
    db: Db,
    shareId: string,
    ipHash: Buffer,
    now: Date,
    dedupeSince: Date,
  ): Promise<{ newViewer: boolean } | null> {
    const { rows } = await db.query<{ new_viewer: boolean }>(
      `INSERT INTO share_viewers (share_id, ip_hash, first_seen_at, last_viewed_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (share_id, ip_hash) DO UPDATE SET last_viewed_at = EXCLUDED.last_viewed_at
         WHERE share_viewers.last_viewed_at IS NULL OR share_viewers.last_viewed_at <= $4
       RETURNING (xmax = 0) AS new_viewer`,
      [shareId, ipHash, now, dedupeSince],
    );
    return rows[0] ? { newViewer: rows[0].new_viewer } : null;
  },

  /** Records a downloading viewer. Downloads are never de-duplicated. */
  async upsertViewerForDownload(db: Db, shareId: string, ipHash: Buffer, now: Date): Promise<{ newViewer: boolean }> {
    const { rows } = await db.query<{ new_viewer: boolean }>(
      `INSERT INTO share_viewers (share_id, ip_hash, first_seen_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (share_id, ip_hash) DO UPDATE SET first_seen_at = share_viewers.first_seen_at
       RETURNING (xmax = 0) AS new_viewer`,
      [shareId, ipHash, now],
    );
    return { newViewer: rows[0]!.new_viewer };
  },

  /**
   * Updates the link's counters for a successful access and returns its distinct viewer count.
   * The download itself was already counted by claimDownload.
   */
  async countSuccess(db: Db, shareId: string, input: { view: boolean; newViewer: boolean; at: Date }): Promise<number> {
    const { rows } = await db.query<{ viewer_count: number }>(
      `UPDATE shares SET
         open_count        = open_count + $2,
         viewer_count      = viewer_count + $3,
         first_accessed_at = COALESCE(first_accessed_at, $4),
         last_accessed_at  = GREATEST(COALESCE(last_accessed_at, $4), $4)
       WHERE id = $1
       RETURNING viewer_count`,
      [shareId, input.view ? 1 : 0, input.newViewer ? 1 : 0, input.at],
    );
    return rows[0]?.viewer_count ?? 0;
  },

  async countBlocked(db: Db, shareId: string): Promise<void> {
    await db.query('UPDATE shares SET blocked_count = blocked_count + 1 WHERE id = $1', [shareId]);
  },

  /** Activity for a set of links, straight from their counters. */
  async activityFor(db: Db, shareIds: string[]): Promise<Map<string, ShareActivity>> {
    if (shareIds.length === 0) return new Map();
    const { rows } = await db.query<{
      id: string;
      open_count: string;
      download_count: number;
      viewer_count: number;
      first_accessed_at: Date | null;
      last_accessed_at: Date | null;
      blocked_count: string;
    }>(
      `SELECT id, open_count, download_count, viewer_count, first_accessed_at, last_accessed_at, blocked_count
         FROM shares WHERE id = ANY($1::uuid[])`,
      [shareIds],
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          opens: Number(r.open_count),
          downloads: Number(r.download_count),
          distinctViewers: Number(r.viewer_count),
          firstAccessedAt: r.first_accessed_at,
          lastAccessedAt: r.last_accessed_at,
          blockedAttempts: Number(r.blocked_count),
        },
      ]),
    );
  },

  /**
   * Keeps event partitions ready for the next months and drops partitions entirely older than
   * `retentionMonths`. Returns the names of dropped partitions.
   */
  async maintainEventPartitions(db: Db, now: Date, monthsAhead: number, retentionMonths: number): Promise<string[]> {
    await db.query('SELECT ensure_share_event_partitions($1, $2)', [now, monthsAhead + 1]);
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retentionMonths, 1));
    // Runs as the table owner (SECURITY DEFINER): the application role can't drop tables itself.
    const { rows } = await db.query<{ name: string }>('SELECT drop_share_event_partitions_before($1) AS name', [
      cutoff,
    ]);
    return rows.map((r) => r.name);
  },

  async listEvents(db: Db, shareId: string, limit = 20) {
    const { rows } = await db.query<{
      accessed_at: Date;
      outcome: AccessOutcome;
      user_agent: string | null;
      ip_hash: Buffer;
      viewer_email: string | null;
    }>(
      `SELECT accessed_at, outcome, user_agent, ip_hash, viewer_email FROM share_access_events
        WHERE share_id = $1 ORDER BY accessed_at DESC LIMIT $2`,
      [shareId, limit],
    );
    return rows;
  },

  /** All of a link's access events, newest first, in keyset pages: for exports of any size. */
  async eventsPage(db: Db, shareId: string, after: { at: Date; id: string } | null, limit: number) {
    const { rows } = await db.query<{
      id: string;
      accessed_at: Date;
      outcome: AccessOutcome;
      user_agent: string | null;
      ip_hash: Buffer;
      viewer_email: string | null;
    }>(
      `SELECT id, accessed_at, outcome, user_agent, ip_hash, viewer_email FROM share_access_events
        WHERE share_id = $1 AND ($2::timestamptz IS NULL OR (accessed_at, id) < ($2, $3::uuid))
        ORDER BY accessed_at DESC, id DESC
        LIMIT $4`,
      [shareId, after?.at ?? null, after?.id ?? null, limit],
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
    changes: {
      expiresAt?: Date | null;
      passwordHash?: string | null;
      maxDownloads?: number | null;
      allowDownload?: boolean;
      allowedEmails?: string[];
    },
  ): Promise<ShareRow> {
    const { rows } = await db.query<ShareRow>(
      `UPDATE shares AS s
          SET expires_at     = CASE WHEN $2 THEN $3::timestamptz ELSE expires_at END,
              password_hash  = CASE WHEN $4 THEN $5::text ELSE password_hash END,
              max_downloads  = CASE WHEN $6 THEN $7::integer ELSE max_downloads END,
              allow_download = COALESCE($8::boolean, allow_download),
              allowed_emails = COALESCE($9::text[], allowed_emails)
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
        changes.allowDownload ?? null,
        changes.allowedEmails ?? null,
      ],
    );
    return rows[0]!;
  },

  async insertEmailCode(
    db: Db,
    code: { id: string; shareId: string; email: string; codeHash: Buffer; expiresAt: Date; now: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO share_email_codes (id, share_id, email, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code.id, code.shareId, code.email, code.codeHash, code.expiresAt, code.now],
    );
  },

  /** Codes sent to an address for a link since a moment, to limit how often one is sent. */
  async emailCodesSince(db: Db, shareId: string, email: string, since: Date): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM share_email_codes WHERE share_id = $1 AND email = $2 AND created_at > $3`,
      [shareId, email, since],
    );
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * Retires every earlier code for an address on a link, so only the one about to be sent works.
   * Done by state rather than by comparing send times, which can tie.
   */
  async supersedeEmailCodes(db: Db, shareId: string, email: string, now: Date): Promise<void> {
    // Two requests at once would each find nothing to retire; take turns for the rest of the
    // transaction so exactly one code stays live.
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`share-code:${shareId}:${email}`]);
    await db.query(
      `UPDATE share_email_codes SET consumed_at = $3
        WHERE share_id = $1 AND email = $2 AND consumed_at IS NULL`,
      [shareId, email, now],
    );
  },

  /** The one code for an address on a link that can still be used, if any. */
  async liveEmailCode(db: Db, shareId: string, email: string): Promise<EmailCodeRow | null> {
    const { rows } = await db.query<EmailCodeRow>(
      `SELECT id, code_hash, expires_at, attempts, consumed_at FROM share_email_codes
        WHERE share_id = $1 AND email = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [shareId, email],
    );
    return rows[0] ?? null;
  },

  /** Counts one wrong guess; returns the attempts so far. */
  async failEmailCode(db: Db, id: string): Promise<number> {
    const { rows } = await db.query<{ attempts: number }>(
      `UPDATE share_email_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [id],
    );
    return rows[0]?.attempts ?? 0;
  },

  /** Uses a code up. False if it was already used (two tabs racing with the same code). */
  async consumeEmailCode(db: Db, id: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE share_email_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
      [id, now],
    );
    return (rowCount ?? 0) > 0;
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
    // Folder links too: whoever can no longer share mustn't keep a folder open to the outside.
    const folders = await db.query(
      `UPDATE folder_shares SET revoked_at = $3
        WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
      [workspaceId, userId, now],
    );
    // And file requests: whoever can no longer upload mustn't keep a way in for others.
    const requests = await db.query(
      `UPDATE file_requests SET revoked_at = $3
        WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
      [workspaceId, userId, now],
    );
    return (rowCount ?? 0) + (folders.rowCount ?? 0) + (requests.rowCount ?? 0);
  },
};
