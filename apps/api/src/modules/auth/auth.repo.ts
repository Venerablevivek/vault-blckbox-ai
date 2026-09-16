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
  expires_at: Date;
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

  async insertUser(
    db: Db,
    user: { id: string; email: string; passwordHash: string },
  ): Promise<UserRow> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
      [user.id, user.email, user.passwordHash],
    );
    return rows[0]!;
  },

  async insertSession(
    db: Db,
    session: { id: string; userId: string; tokenHash: Buffer; expiresAt: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [session.id, session.userId, session.tokenHash, session.expiresAt],
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
  ): Promise<{ id: string; email: string } | null> {
    const { rows } = await db.query<{ id: string; email: string }>(
      `SELECT u.id, u.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  },

  async deleteSession(db: Db, tokenHash: Buffer): Promise<void> {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  },
};
