import type { Db } from '../../db/pool';

export interface WebhookRow {
  id: string;
  workspace_id: string;
  url: string;
  secret: string;
  events: string[];
  created_by: string;
  created_at: Date;
  disabled_at: Date | null;
  disabled_reason: string | null;
  consecutive_failures: number;
  last_delivery_at: Date | null;
  last_status: number | null;
}

export interface DeliveryRow {
  id: string;
  event_id: string | null;
  event_type: string;
  success: boolean;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  attempted_at: Date;
}

export const webhooksRepo = {
  async insert(
    db: Db,
    hook: {
      id: string;
      workspaceId: string;
      url: string;
      secret: string;
      events: string[];
      createdBy: string;
      now: Date;
    },
  ): Promise<WebhookRow> {
    const { rows } = await db.query<WebhookRow>(
      `INSERT INTO webhooks (id, workspace_id, url, secret, events, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [hook.id, hook.workspaceId, hook.url, hook.secret, hook.events, hook.createdBy, hook.now],
    );
    return rows[0]!;
  },

  async listForWorkspace(db: Db, workspaceId: string): Promise<WebhookRow[]> {
    const { rows } = await db.query<WebhookRow>(
      'SELECT * FROM webhooks WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId],
    );
    return rows;
  },

  async count(db: Db, workspaceId: string): Promise<number> {
    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM webhooks WHERE workspace_id = $1', [
      workspaceId,
    ]);
    return Number(rows[0]?.n ?? 0);
  },

  async find(db: Db, workspaceId: string, id: string): Promise<WebhookRow | null> {
    const { rows } = await db.query<WebhookRow>('SELECT * FROM webhooks WHERE id = $1 AND workspace_id = $2', [
      id,
      workspaceId,
    ]);
    return rows[0] ?? null;
  },

  async findById(db: Db, id: string): Promise<WebhookRow | null> {
    const { rows } = await db.query<WebhookRow>('SELECT * FROM webhooks WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /** Enabled webhooks of a workspace that want an action. */
  async subscribers(db: Db, workspaceId: string, action: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM webhooks WHERE workspace_id = $1 AND disabled_at IS NULL AND $2 = ANY (events)',
      [workspaceId, action],
    );
    return rows.map((r) => r.id);
  },

  async update(
    db: Db,
    id: string,
    changes: { url?: string; events?: string[]; enabled?: boolean },
  ): Promise<WebhookRow> {
    const { rows } = await db.query<WebhookRow>(
      `UPDATE webhooks
          SET url = COALESCE($2, url),
              events = COALESCE($3::text[], events),
              disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at
                                 WHEN $4 THEN NULL ELSE COALESCE(disabled_at, now()) END,
              disabled_reason = CASE WHEN $4::boolean IS NULL THEN disabled_reason
                                     WHEN $4 THEN NULL ELSE 'turned off by an owner' END,
              consecutive_failures = CASE WHEN $4 THEN 0 ELSE consecutive_failures END
        WHERE id = $1
        RETURNING *`,
      [id, changes.url ?? null, changes.events ?? null, changes.enabled ?? null],
    );
    return rows[0]!;
  },

  async delete(db: Db, id: string): Promise<void> {
    await db.query('DELETE FROM webhooks WHERE id = $1', [id]);
  },

  async recordDelivery(
    db: Db,
    delivery: {
      id: string;
      webhookId: string;
      workspaceId: string;
      eventId: string | null;
      eventType: string;
      success: boolean;
      statusCode: number | null;
      error: string | null;
      durationMs: number;
      at: Date;
    },
    disableAfter: number,
  ): Promise<{ disabled: boolean }> {
    await db.query(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, workspace_id, event_id, event_type, success, status_code, error, duration_ms, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        delivery.id,
        delivery.webhookId,
        delivery.workspaceId,
        delivery.eventId,
        delivery.eventType,
        delivery.success,
        delivery.statusCode,
        delivery.error,
        delivery.durationMs,
        delivery.at,
      ],
    );
    const { rows } = await db.query<{ disabled: boolean }>(
      `UPDATE webhooks
          SET last_delivery_at = $2, last_status = $3,
              consecutive_failures = CASE WHEN $4 THEN 0 ELSE consecutive_failures + 1 END,
              disabled_at = CASE WHEN NOT $4 AND consecutive_failures + 1 >= $5 AND disabled_at IS NULL
                                 THEN $2 ELSE disabled_at END,
              disabled_reason = CASE WHEN NOT $4 AND consecutive_failures + 1 >= $5 AND disabled_at IS NULL
                                     THEN 'too many failed deliveries in a row' ELSE disabled_reason END
        WHERE id = $1
        RETURNING disabled_at IS NOT NULL AS disabled`,
      [delivery.webhookId, delivery.at, delivery.statusCode, delivery.success, disableAfter],
    );
    return { disabled: rows[0]?.disabled ?? true };
  },

  async recentDeliveries(db: Db, webhookId: string, limit: number): Promise<DeliveryRow[]> {
    const { rows } = await db.query<DeliveryRow>(
      `SELECT id, event_id, event_type, success, status_code, error, duration_ms, attempted_at
         FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY attempted_at DESC, id DESC LIMIT $2`,
      [webhookId, limit],
    );
    return rows;
  },

  async pruneDeliveries(db: Db, before: Date): Promise<number> {
    const { rowCount } = await db.query('DELETE FROM webhook_deliveries WHERE attempted_at < $1', [before]);
    return rowCount ?? 0;
  },
};
