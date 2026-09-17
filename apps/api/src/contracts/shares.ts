import { obj, timestamp, uuid, z } from './common';

export const ShareIdParams = obj({ id: uuid });
export const ShareTokenParams = obj({ token: z.string().min(10).max(200) });

const linkSettings = {
  expiresInHours: z.number().int().positive().max(8760).nullable().optional().openapi({ description: 'null = never expires; omitted = the default (create) or unchanged (edit).' }),
  password: z.string().min(6).max(128).nullable().optional().openapi({ description: 'null removes the password.' }),
  maxDownloads: z.number().int().min(1).max(1000).nullable().optional().openapi({ description: 'null = unlimited; 1 = one-time link.' }),
};
export const CreateShareBody = z.object({ documentId: uuid, ...linkSettings }).openapi('CreateShareRequest');
export const UpdateShareBody = z.object(linkSettings).openapi('UpdateShareRequest');
export const UnlockBody = z.object({ password: z.string().min(1).max(128) }).openapi('UnlockRequest');

export const ShareActivity = obj({
  opens: z.number().int(),
  downloads: z.number().int(),
  distinctViewers: z.number().int().openapi({ description: 'Estimate: NAT merges viewers, network changes split them.' }),
  firstAccessedAt: timestamp.nullable(),
  lastAccessedAt: timestamp.nullable(),
  blockedAttempts: z.number().int(),
}).openapi('ShareActivity');

export const ShareSummary = obj({
  id: uuid,
  createdBy: uuid,
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  hasPassword: z.boolean(),
  maxDownloads: z.number().int().nullable(),
  downloadCount: z.number().int(),
  activity: ShareActivity,
}).openapi('ShareSummary');

export const SharesResponse = obj({ shares: z.array(ShareSummary) });
export const ShareCreatedResponse = obj({
  share: obj({
    id: uuid,
    url: z.string().url().openapi({ description: 'Contains the token. Returned only here, once.' }),
    expiresAt: timestamp.nullable(),
    createdAt: timestamp,
    hasPassword: z.boolean(),
    maxDownloads: z.number().int().nullable(),
  }),
});
export const ShareUpdatedResponse = obj({
  share: obj({ id: uuid, expiresAt: timestamp.nullable(), hasPassword: z.boolean(), maxDownloads: z.number().int().nullable(), downloadCount: z.number().int() }),
});

export const ShareOutcome = z
  .enum(['resolved', 'downloaded', 'expired', 'revoked', 'document_deleted', 'exhausted', 'bad_password'])
  .openapi('ShareOutcome');
export const ShareEventsResponse = obj({
  events: z.array(
    obj({
      accessedAt: timestamp,
      outcome: ShareOutcome,
      userAgent: z.string().nullable(),
      viewer: z.string().regex(/^[0-9a-f]{8}$/).openapi({ description: 'Opaque marker for "the same viewer". Never an address.' }),
    }),
  ),
});

export const PublicShareResponse = z
  .union([
    obj({ requiresPassword: z.literal(true), expiresAt: timestamp.nullable() }),
    obj({
      requiresPassword: z.literal(false),
      passwordProtected: z.boolean(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number().int(),
      expiresAt: timestamp.nullable(),
      downloadsRemaining: z.number().int().nullable(),
    }),
  ])
  .openapi('PublicShare');
