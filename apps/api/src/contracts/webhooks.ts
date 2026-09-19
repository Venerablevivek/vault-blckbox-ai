import { AuditAction } from './activity';
import { obj, timestamp, uuid, z } from './common';

export const WebhookParams = obj({ id: uuid, webhookId: uuid });

const events = z
  .array(AuditAction)
  .min(1)
  .max(50)
  .openapi({ description: 'Activity to send: any of the audit actions.' });
const url = z.string().trim().max(2000).openapi({
  description: 'An https URL on a public address. Redirects are not followed.',
});

export const CreateWebhookBody = z.object({ url, events }).openapi('CreateWebhookRequest');
export const UpdateWebhookBody = z
  .object({
    url: url.optional(),
    events: events.optional(),
    enabled: z
      .boolean()
      .optional()
      .openapi({ description: 'true switches a disabled webhook back on and resets its failure count.' }),
  })
  .refine((b) => b.url !== undefined || b.events !== undefined || b.enabled !== undefined, 'Nothing to change.')
  .openapi('UpdateWebhookRequest');

export const Webhook = obj({
  id: uuid,
  url: z.string(),
  events: z.array(z.string()),
  createdAt: timestamp,
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: timestamp.nullable(),
  lastStatus: z.number().int().nullable(),
}).openapi('Webhook');

export const WebhooksResponse = obj({ webhooks: z.array(Webhook) });
export const WebhookResponse = obj({ webhook: Webhook });
export const WebhookCreatedResponse = obj({
  webhook: Webhook,
  secret: z.string().openapi({
    description:
      'Signs every delivery: the Vault-Signature header is t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. Returned only here.',
  }),
});
export const WebhookDelivery = obj({
  id: uuid,
  eventId: uuid.nullable(),
  eventType: z.string(),
  success: z.boolean(),
  statusCode: z.number().int().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
  attemptedAt: timestamp,
}).openapi('WebhookDelivery');
export const WebhookDeliveriesResponse = obj({ deliveries: z.array(WebhookDelivery) });
export const WebhookPingResponse = obj({
  success: z.boolean(),
  statusCode: z.number().int().nullable(),
  error: z.string().nullable(),
});
