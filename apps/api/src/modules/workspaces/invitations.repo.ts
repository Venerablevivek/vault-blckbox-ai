import type { Db } from '../../db/pool';
import type { Role } from '../../types';

export interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  expires_at: Date;
  accepted_at: Date | null;
  created_by: string;
  created_at: Date;
}

export const invitationsRepo = {
  /**
   * Re-inviting an address replaces the pending invite rather than creating a second one.
   * The partial unique index (workspace_id, email) WHERE accepted_at IS NULL is what makes
   * the conflict target valid.
   */
  async upsertPending(
    db: Db,
    invite: {
      id: string;
      workspaceId: string;
      email: string;
      tokenHash: Buffer;
      role: Role;
      expiresAt: Date;
      createdBy: string;
    },
  ): Promise<InvitationRow> {
    const { rows } = await db.query<InvitationRow>(
      `INSERT INTO invitations (id, workspace_id, email, token_hash, role, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, email) WHERE accepted_at IS NULL
       DO UPDATE SET token_hash = EXCLUDED.token_hash,
                     role       = EXCLUDED.role,
                     expires_at = EXCLUDED.expires_at,
                     created_by = EXCLUDED.created_by,
                     created_at = now()
       RETURNING id, workspace_id, email, role, expires_at, accepted_at, created_by, created_at`,
      [invite.id, invite.workspaceId, invite.email, invite.tokenHash, invite.role, invite.expiresAt, invite.createdBy],
    );
    return rows[0]!;
  },

  async findByTokenHash(db: Db, tokenHash: Buffer): Promise<(InvitationRow & { workspace_name: string }) | null> {
    const { rows } = await db.query<InvitationRow & { workspace_name: string }>(
      `SELECT i.*, w.name AS workspace_name
         FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },

  /**
   * Revokes a pending invitation by deleting it. Scoped by workspace, so an invitation id
   * from another workspace matches nothing. Accepted invitations are history and stay.
   */
  async deletePending(db: Db, workspaceId: string, id: string): Promise<{ email: string } | null> {
    const { rows } = await db.query<{ email: string }>(
      `DELETE FROM invitations
        WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL
        RETURNING email`,
      [id, workspaceId],
    );
    return rows[0] ?? null;
  },

  async listPending(db: Db, workspaceId: string): Promise<InvitationRow[]> {
    const { rows } = await db.query<InvitationRow>(
      `SELECT id, workspace_id, email, role, expires_at, accepted_at, created_by, created_at
         FROM invitations
        WHERE workspace_id = $1 AND accepted_at IS NULL
        ORDER BY created_at DESC`,
      [workspaceId],
    );
    return rows;
  },

  /**
   * Single-use acceptance, enforced in one statement.
   *
   * Zero rows returned means the invitation was already accepted or has expired — there
   * is no read-then-write window in which two concurrent accepts could both succeed.
   */
  async markAccepted(
    db: Db,
    id: string,
    now: Date,
  ): Promise<{ workspace_id: string; email: string; role: Role } | null> {
    const { rows } = await db.query<{ workspace_id: string; email: string; role: Role }>(
      `UPDATE invitations
          SET accepted_at = $2
        WHERE id = $1 AND accepted_at IS NULL AND expires_at > $2
        RETURNING workspace_id, email, role`,
      [id, now],
    );
    return rows[0] ?? null;
  },
};
