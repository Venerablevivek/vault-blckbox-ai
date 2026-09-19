import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { withTransaction } from '../../db/tx';
import { Errors } from '../../lib/errors';
import { BlockedDestinationError, checkWebhookUrl, postJson } from '../../lib/safe-http';
import type { Clock } from '../../types';
import { auditRepo } from '../audit/audit.repo';
import type { AuditService } from '../audit/audit.service';
import { webhooksRepo, type WebhookRow } from './webhooks.repo';
import { webhookDeliveries } from '../../observability/metrics';

/** Webhooks one workspace may have. */
export const MAX_WEBHOOKS = 10;
/** Failed deliveries in a row after which a webhook is switched off. */
export const DISABLE_AFTER_FAILURES = 15;

/**
 * The signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>`.
 * Receivers recompute it and reject old timestamps, which stops replays.
 */
export function signPayload(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

export function createWebhooksService(deps: {
  pool: Pool;
  clock: Clock;
  logger: Logger;
  audit: AuditService;
  allowInsecure: boolean;
  timeoutMs: number;
}) {
  const { pool, clock, logger, audit } = deps;

  function cleanUrl(url: string): string {
    try {
      return checkWebhookUrl(url, deps.allowInsecure).toString();
    } catch (error) {
      if (error instanceof BlockedDestinationError) throw Errors.badRequest('INVALID_WEBHOOK_URL', error.message);
      throw error;
    }
  }

  async function requireHook(workspaceId: string, webhookId: string): Promise<WebhookRow> {
    const hook = await webhooksRepo.find(pool, workspaceId, webhookId);
    if (!hook) throw Errors.notFound('Webhook');
    return hook;
  }

  /** Sends one payload and records the attempt. Never throws for the receiver's failures. */
  async function send(hook: WebhookRow, event: { id: string | null; type: string }, payload: object) {
    const body = JSON.stringify(payload);
    const started = Date.now();
    const now = clock.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const response = await postJson(
        hook.url,
        body,
        {
          'user-agent': 'Vault-Webhooks/1.0',
          'vault-event': event.type,
          'vault-delivery': event.id ?? 'ping',
          'vault-signature': signPayload(hook.secret, body, Math.floor(now.getTime() / 1000)),
        },
        { allowInsecure: deps.allowInsecure, timeoutMs: deps.timeoutMs },
      );
      statusCode = response.status;
      if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : 'request failed';
    }
    const success = error === null;
    webhookDeliveries.inc({ success: String(success) });
    const { disabled } = await webhooksRepo.recordDelivery(
      pool,
      {
        id: randomUUID(),
        webhookId: hook.id,
        workspaceId: hook.workspace_id,
        eventId: event.id,
        eventType: event.type,
        success,
        statusCode,
        error,
        durationMs: Date.now() - started,
        at: now,
      },
      DISABLE_AFTER_FAILURES,
    );
    if (disabled && !success) logger.warn({ webhookId: hook.id }, 'webhook disabled after repeated failures');
    return { success, statusCode, error, disabled };
  }

  return {
    list(workspaceId: string) {
      return webhooksRepo.listForWorkspace(pool, workspaceId);
    },

    /** Adds a webhook. Its signing secret is returned only here. */
    async create(workspaceId: string, userId: string, input: { url: string; events: string[] }) {
      const url = cleanUrl(input.url);
      const secret = `whsec_${randomBytes(24).toString('base64url')}`;
      return withTransaction(pool, async (tx) => {
        if ((await webhooksRepo.count(tx, workspaceId)) >= MAX_WEBHOOKS) {
          throw Errors.conflict('TOO_MANY_WEBHOOKS', `A workspace can have up to ${MAX_WEBHOOKS} webhooks.`);
        }
        const hook = await webhooksRepo.insert(tx, {
          id: randomUUID(),
          workspaceId,
          url,
          secret,
          events: [...new Set(input.events)].sort(),
          createdBy: userId,
          now: clock.now(),
        });
        await audit.record(
          {
            workspaceId,
            actorUserId: userId,
            action: 'webhook.created',
            resourceType: 'webhook',
            resourceId: hook.id,
            metadata: { url: new URL(url).origin, events: hook.events },
          },
          tx,
        );
        return { hook, secret };
      });
    },

    async update(
      workspaceId: string,
      webhookId: string,
      userId: string,
      changes: { url?: string; events?: string[]; enabled?: boolean },
    ) {
      await requireHook(workspaceId, webhookId);
      const updated = await webhooksRepo.update(pool, webhookId, {
        url: changes.url === undefined ? undefined : cleanUrl(changes.url),
        events: changes.events ? [...new Set(changes.events)].sort() : undefined,
        enabled: changes.enabled,
      });
      await audit.record({
        workspaceId,
        actorUserId: userId,
        action: 'webhook.updated',
        resourceType: 'webhook',
        resourceId: webhookId,
        metadata: { url: new URL(updated.url).origin, events: updated.events, enabled: updated.disabled_at === null },
      });
      return updated;
    },

    async remove(workspaceId: string, webhookId: string, userId: string): Promise<void> {
      const hook = await requireHook(workspaceId, webhookId);
      await webhooksRepo.delete(pool, webhookId);
      await audit.record({
        workspaceId,
        actorUserId: userId,
        action: 'webhook.deleted',
        resourceType: 'webhook',
        resourceId: webhookId,
        metadata: { url: new URL(hook.url).origin },
      });
    },

    async deliveries(workspaceId: string, webhookId: string) {
      await requireHook(workspaceId, webhookId);
      return webhooksRepo.recentDeliveries(pool, webhookId, 50);
    },

    /** Sends a "webhook.ping" right away, so an owner can check their endpoint. */
    async ping(workspaceId: string, webhookId: string) {
      const hook = await requireHook(workspaceId, webhookId);
      const { success, statusCode, error } = await send(
        hook,
        { id: null, type: 'webhook.ping' },
        { type: 'webhook.ping', workspaceId, createdAt: clock.now().toISOString() },
      );
      return { success, statusCode, error };
    },

    /**
     * Job handler: delivers one event. A receiver that fails (an error status, a timeout) makes
     * the job fail, so it is retried with backoff; a webhook that was removed or switched off in
     * the meantime is skipped.
     */
    async deliver(webhookId: string, eventId: string): Promise<void> {
      const hook = await webhooksRepo.findById(pool, webhookId);
      if (!hook || hook.disabled_at) return;
      const event = await auditRepo.findEvent(pool, eventId);
      if (!event) return;
      const result = await send(
        hook,
        { id: event.id, type: event.action },
        {
          id: event.id,
          type: event.action,
          createdAt: event.created_at.toISOString(),
          workspaceId: hook.workspace_id,
          actor: event.actor_user_id ? { id: event.actor_user_id, email: event.actor_email } : null,
          resource: { type: event.resource_type, id: event.resource_id },
          data: event.metadata,
        },
      );
      if (!result.success && !result.disabled) throw new Error(`webhook delivery failed: ${result.error}`);
    },

    pruneDeliveries(before: Date) {
      return webhooksRepo.pruneDeliveries(pool, before);
    },
  };
}

export type WebhooksService = ReturnType<typeof createWebhooksService>;
