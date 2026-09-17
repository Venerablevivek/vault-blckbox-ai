import type { Db } from '../../db/pool';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
}

export interface PasswordResetRow {
  id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

export const authRepo = {
  async findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ?? null;
  },

  async findUserById(db: Db, id: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async insertUser(db: Db, user: { id: string; email: string; passwordHash: string }): Promise<UserRow> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
      [user.id, user.email, user.passwordHash],
    );
    return rows[0]!;
  },

  async insertSession(
    db: Db,
    session: { id: string; userId: string; tokenHash: Buffer; expiresAt: Date; userAgent: string | null; now: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [session.id, session.userId, session.tokenHash, session.expiresAt, session.userAgent, session.now],
    );
  },

  /**
   * Resolves a session token hash to its user, rejecting expired rows in SQL so an
   * expired session can never be treated as valid by a missing check in application code.
   */
  async findValidSession(
    db: Db,
    tokenHash: Buffer,
    now: Date,
  ): Promise<{ id: string; email: string; session_id: string; last_seen_at: Date | null } | null> {
    const { rows } = await db.query<{ id: string; email: string; session_id: string; last_seen_at: Date | null }>(
      `SELECT u.id, u.email, s.id AS session_id, s.last_seen_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  async touchSession(db: Db, sessionId: string, now: Date): Promise<void> {
    await db.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [sessionId, now]);
  },

  async listSessions(db: Db, userId: string, now: Date): Promise<SessionRow[]> {
    const { rows } = await db.query<SessionRow>(
      `SELECT id, user_id, user_agent, created_at, last_seen_at, expires_at
         FROM sessions
        WHERE user_id = $1 AND expires_at > $2
        ORDER BY COALESCE(last_seen_at, created_at) DESC`,
      [userId, now],
    );
    return rows;
  },

  /** Deletes one of the user's own sessions. Scoped by user so an id alone can't end someone else's. */
  async deleteSessionById(db: Db, userId: string, sessionId: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
    return (rowCount ?? 0) > 0;
  },

  /** Every session for the user except `keepSessionId` (null = all of them). */
  async deleteOtherSessions(db: Db, userId: string, keepSessionId: string | null): Promise<number> {
    const { rowCount } = await db.query(
      'DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [userId, keepSessionId],
    );
    return rowCount ?? 0;
  },

  async updatePassword(db: Db, userId: string, passwordHash: string, now: Date): Promise<void> {
    await db.query('UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1', [
      userId,
      passwordHash,
      now,
    ]);
  },

  async insertPasswordReset(
    db: Db,
    reset: { id: string; userId: string; tokenHash: Buffer; expiresAt: Date; now: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [reset.id, reset.userId, reset.tokenHash, reset.expiresAt, reset.now],
    );
  },

  /** Reset requests for a user since `since`, to stop one address being flooded with emails. */
  async countRecentPasswordResets(db: Db, userId: string, since: Date): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM password_resets WHERE user_id = $1 AND created_at > $2',
      [userId, since],
    );
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Claims a reset token: marks it used only if it is unused and unexpired, in one statement,
   * so two simultaneous submissions of the same link cannot both succeed.
   */
  async claimPasswordReset(db: Db, tokenHash: Buffer, now: Date): Promise<PasswordResetRow | null> {
    const { rows } = await db.query<PasswordResetRow>(
      `UPDATE password_resets SET used_at = $2
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING id, user_id, expires_at, used_at`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  async invalidatePasswordResets(db: Db, userId: string, now: Date): Promise<void> {
    await db.query('UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [userId, now]);
  },

  /**
   * Failures inside the window: how many, and when the oldest happened. The lockout lifts
   * when that oldest failure falls out of the window.
   */
  async recentLoginFailures(db: Db, key: Buffer, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const { rows } = await db.query<{ count: string; oldest: Date | null }>(
      `SELECT COUNT(*) AS count, MIN(failed_at) AS oldest
         FROM login_failures WHERE email_hash = $1 AND failed_at > $2`,
      [key, since],
    );
    return { count: Number(rows[0]?.count ?? 0), oldest: rows[0]?.oldest ?? null };
  },

  async recordLoginFailure(db: Db, key: Buffer, at: Date): Promise<void> {
    await db.query('INSERT INTO login_failures (email_hash, failed_at) VALUES ($1, $2)', [key, at]);
  },

  async clearLoginFailures(db: Db, key: Buffer): Promise<void> {
    await db.query('DELETE FROM login_failures WHERE email_hash = $1', [key]);
  },

  async deleteSession(db: Db, tokenHash: Buffer): Promise<void> {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  },
};
