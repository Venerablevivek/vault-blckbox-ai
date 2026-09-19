import type { Db } from '../../db/pool';

export type TokenScope = 'read' | 'write';

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  scopes: TokenScope[];
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
}

const COLUMNS = 'id, user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at';

export const tokensRepo = {
  async insert(
    db: Db,
    token: {
      id: string;
      userId: string;
      name: string;
      tokenHash: Buffer;
      tokenPrefix: string;
      scopes: TokenScope[];
      expiresAt: Date | null;
      now: Date;
    },
  ): Promise<ApiTokenRow> {
    const { rows } = await db.query<ApiTokenRow>(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scopes, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [
        token.id,
        token.userId,
        token.name,
        token.tokenHash,
        token.tokenPrefix,
        token.scopes,
        token.expiresAt,
        token.now,
      ],
    );
    return rows[0]!;
  },

  /** Live tokens of one person, newest first. */
  async listForUser(db: Db, userId: string, now: Date): Promise<ApiTokenRow[]> {
    const { rows } = await db.query<ApiTokenRow>(
      `SELECT ${COLUMNS} FROM api_tokens
        WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY created_at DESC`,
      [userId, now],
    );
    return rows;
  },

  async countLive(db: Db, userId: string, now: Date): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM api_tokens
        WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
      [userId, now],
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** A usable token and its owner, by hash. */
  async resolve(db: Db, tokenHash: Buffer, now: Date) {
    const { rows } = await db.query<ApiTokenRow & { email: string; email_verified_at: Date | null }>(
      `SELECT t.id, t.user_id, t.name, t.token_prefix, t.scopes, t.created_at, t.last_used_at, t.expires_at,
              u.email, u.email_verified_at
         FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > $2)`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  async touch(db: Db, id: string, now: Date): Promise<void> {
    await db.query('UPDATE api_tokens SET last_used_at = $2 WHERE id = $1', [id, now]);
  },

  async revoke(db: Db, userId: string, id: string, now: Date): Promise<boolean> {
    const { rowCount } = await db.query(
      'UPDATE api_tokens SET revoked_at = $3 WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL',
      [userId, id, now],
    );
    return (rowCount ?? 0) > 0;
  },

  async revokeAll(db: Db, userId: string, now: Date): Promise<number> {
    const { rowCount } = await db.query(
      'UPDATE api_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, now],
    );
    return rowCount ?? 0;
  },
};
