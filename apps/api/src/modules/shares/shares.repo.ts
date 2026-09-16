import type { Db } from '../../db/pool';

export type AccessOutcome =
  | 'resolved'
  | 'downloaded'
  | 'expired'
  | 'revoked'
  | 'document_deleted';

export interface ShareState {
  id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  document_deleted_at: Date | null;
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

export interface ShareRow {
  id: string;
  document_id: string;
  expires_at: Date | null;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
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
}

export const sharesRepo = {
  async insert(
    db: Db,
    share: {
      id: string;
      documentId: string;
      tokenHash: Buffer;
      expiresAt: Date | null;
      createdBy: string;
    },
  ): Promise<ShareRow> {
    const { rows } = await db.query<ShareRow>(
      `INSERT INTO shares (id, document_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, document_id, expires_at, created_by, created_at, revoked_at`,
      [share.id, share.documentId, share.tokenHash, share.expiresAt, share.createdBy],
    );
    return rows[0]!;
  },

  /**
   * Resolves a share token to its document.
   *
   * Every liveness rule is expressed in SQL — not revoked, not expired, and the document
   * itself not soft-deleted. The join on documents is what makes deleting a document kill
   * all of its links instantly, with no separate cleanup pass and nothing cached.
   *
   * Returns null for "no such token" and for "token exists but is dead"; the caller
   * distinguishes them with `findAnyByTokenHash` so it can answer 410 rather than 404.
   */
  async resolveLive(db: Db, tokenHash: Buffer, now: Date): Promise<ResolvedShare | null> {
    const { rows } = await db.query<ResolvedShare>(
      `SELECT s.id           AS share_id,
              d.id           AS document_id,
              d.workspace_id AS workspace_id,
              s.created_by,
              d.filename,
              d.mime_type,
              d.size,
              d.storage_key,
              s.expires_at
         FROM shares s
         JOIN documents d ON d.id = s.document_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > $2)
          AND d.deleted_at IS NULL`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  /**
   * Looks up a token regardless of whether it is still usable.
   *
   * Used to tell a dead link (410) from one that never existed (404), and to attach an
   * access event to the right share when someone tries a link that has been revoked —
   * which is exactly the signal a sender wants to see.
   */
  async findStateByTokenHash(
    db: Db,
    tokenHash: Buffer,
  ): Promise<ShareState | null> {
    const { rows } = await db.query<ShareState>(
      `SELECT s.id,
              s.revoked_at,
              s.expires_at,
              d.deleted_at AS document_deleted_at
         FROM shares s
         JOIN documents d ON d.id = s.document_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },

  /**
   * Records one access. Deliberately fire-and-forget at the call site: a failure to write
   * telemetry must never stop someone downloading a document they are entitled to.
   */
  async recordAccess(
    db: Db,
    event: {
      id: string;
      shareId: string;
      ipHash: Buffer;
      userAgent: string | null;
      outcome: AccessOutcome;
      at: Date;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO share_access_events (id, share_id, accessed_at, ip_hash, user_agent, outcome)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, event.shareId, event.at, event.ipHash, event.userAgent, event.outcome],
    );
  },

  /**
   * Activity rollup for a set of links, in one query rather than N.
   *
   * "Distinct viewers" counts distinct ip_hash values. That is an estimate and is labelled
   * as one in the UI: two people behind the same NAT look like one, and one person moving
   * between wifi and mobile looks like two. Inventing precision here would be worse than
   * admitting the approximation.
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
              COUNT(*)                  FILTER (WHERE outcome = 'resolved') AS opens,
              COUNT(*)                  FILTER (WHERE outcome = 'downloaded') AS downloads,
              COUNT(DISTINCT ip_hash)   FILTER (WHERE outcome IN ('resolved','downloaded')) AS viewers,
              MIN(accessed_at)          FILTER (WHERE outcome IN ('resolved','downloaded')) AS first_at,
              MAX(accessed_at)          FILTER (WHERE outcome IN ('resolved','downloaded')) AS last_at,
              COUNT(*)                  FILTER (WHERE outcome NOT IN ('resolved','downloaded')) AS blocked
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

  /**
   * Has this viewer opened this link before?
   *
   * Drives notification volume: the sender is told about the first open and about each
   * genuinely new viewer, not about every refresh. One indexed existence check per public
   * request is a cheap price for not spamming people.
   */
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

  /** Distinct viewers so far, used to decide when forwarding is worth flagging. */
  async distinctViewerCount(db: Db, shareId: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT ip_hash) AS count
         FROM share_access_events
        WHERE share_id = $1 AND outcome IN ('resolved','downloaded')`,
      [shareId],
    );
    return Number(rows[0]?.count ?? 0);
  },

  /** Most recent events for one link, for the activity detail view. */
  async listEvents(db: Db, shareId: string, limit = 20) {
    const { rows } = await db.query<{
      accessed_at: Date;
      outcome: AccessOutcome;
      user_agent: string | null;
      ip_hash: Buffer;
    }>(
      `SELECT accessed_at, outcome, user_agent, ip_hash
         FROM share_access_events
        WHERE share_id = $1
        ORDER BY accessed_at DESC
        LIMIT $2`,
      [shareId, limit],
    );
    return rows;
  },

  async findById(db: Db, id: string): Promise<(ShareRow & { workspace_id: string }) | null> {
    const { rows } = await db.query<ShareRow & { workspace_id: string }>(
      `SELECT s.id, s.document_id, s.expires_at, s.created_by, s.created_at, s.revoked_at,
              d.workspace_id
         FROM shares s
         JOIN documents d ON d.id = s.document_id
        WHERE s.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async listForDocument(db: Db, documentId: string): Promise<ShareRow[]> {
    const { rows } = await db.query<ShareRow>(
      `SELECT id, document_id, expires_at, created_by, created_at, revoked_at
         FROM shares
        WHERE document_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [documentId],
    );
    return rows;
  },

  async revoke(db: Db, id: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE shares SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, now],
    );
    return (rowCount ?? 0) > 0;
  },
};
