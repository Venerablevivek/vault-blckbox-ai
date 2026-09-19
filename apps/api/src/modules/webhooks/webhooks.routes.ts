import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CreateWebhookBody, UpdateWebhookBody, WebhookParams } from '../../contracts/webhooks';
import { WorkspaceParams } from '../../contracts/workspaces';
import { currentUser, requireSession } from '../../plugins/session';
import { requireOwner } from '../../policy';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { WebhookRow } from './webhooks.repo';
import type { WebhooksService } from './webhooks.service';

const toDto = (hook: WebhookRow) => ({
  id: hook.id,
  url: hook.url,
  events: hook.events,
  createdAt: hook.created_at,
  enabled: hook.disabled_at === null,
  disabledReason: hook.disabled_reason,
  consecutiveFailures: hook.consecutive_failures,
  lastDeliveryAt: hook.last_delivery_at,
  lastStatus: hook.last_status,
});

/** Webhooks are an owner's business: they send the workspace's activity somewhere else. */
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: { webhooks: WebhooksService; workspaces: WorkspacesService },
): void {
  const { webhooks, workspaces } = deps;

  async function owner(request: FastifyRequest, workspaceId: string) {
    const user = currentUser(request);
    requireOwner((await workspaces.requireMember(workspaceId, user.id)).role);
    return user;
  }

  app.get('/api/workspaces/:id/webhooks', { preHandler: requireSession }, async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    await owner(request, id);
    return { webhooks: (await webhooks.list(id)).map(toDto) };
  });

  app.post('/api/workspaces/:id/webhooks', { preHandler: requireSession }, async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const user = await owner(request, id);
    const { hook, secret } = await webhooks.create(id, user.id, CreateWebhookBody.parse(request.body));
    return reply.status(201).send({ webhook: toDto(hook), secret });
  });

  app.patch('/api/workspaces/:id/webhooks/:webhookId', { preHandler: requireSession }, async (request) => {
    const { id, webhookId } = WebhookParams.parse(request.params);
    const user = await owner(request, id);
    return { webhook: toDto(await webhooks.update(id, webhookId, user.id, UpdateWebhookBody.parse(request.body))) };
  });

  app.delete('/api/workspaces/:id/webhooks/:webhookId', { preHandler: requireSession }, async (request, reply) => {
    const { id, webhookId } = WebhookParams.parse(request.params);
    const user = await owner(request, id);
    await webhooks.remove(id, webhookId, user.id);
    return reply.status(204).send();
  });

  app.get('/api/workspaces/:id/webhooks/:webhookId/deliveries', { preHandler: requireSession }, async (request) => {
    const { id, webhookId } = WebhookParams.parse(request.params);
    await owner(request, id);
    const rows = await webhooks.deliveries(id, webhookId);
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        eventId: d.event_id,
        eventType: d.event_type,
        success: d.success,
        statusCode: d.status_code,
        error: d.error,
        durationMs: d.duration_ms,
        attemptedAt: d.attempted_at,
      })),
    };
  });

  app.post('/api/workspaces/:id/webhooks/:webhookId/ping', {
    preHandler: requireSession,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { id, webhookId } = WebhookParams.parse(request.params);
      await owner(request, id);
      return webhooks.ping(id, webhookId);
    },
  });
}
