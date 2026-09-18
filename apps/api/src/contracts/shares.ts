import { obj, timestamp, uuid, z } from './common';

export const ShareIdParams = obj({ id: uuid });
export const ShareTokenParams = obj({ token: z.string().min(10).max(200) });

const linkSettings = {
  expiresInHours: z
    .number()
    .int()
    .positive()
    .max(8760)
    .nullable()
    .optional()
    .openapi({ description: 'null = never expires; omitted = the default (create) or unchanged (edit).' }),
  password: z.string().min(6).max(128).nullable().optional().openapi({ description: 'null removes the password.' }),
  maxDownloads: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .nullable()
    .optional()
    .openapi({ description: 'null = unlimited; 1 = one-time link.' }),
  allowDownload: z.boolean().optional().openapi({
    description:
      'false = view only: the file is shown in the page (watermarked) and cannot be downloaded. PDFs and images only.',
  }),
  allowedEmails: z.array(z.string().trim().email().max(255)).max(50).optional().openapi({
    description:
      'Only these people can open the link, each proving their address with a one-time emailed code. Empty = anyone with the link.',
  }),
};
export const CreateShareBody = z.object({ documentId: uuid, ...linkSettings }).openapi('CreateShareRequest');
export const UpdateShareBody = z.object(linkSettings).openapi('UpdateShareRequest');
export const UnlockBody = z.object({ password: z.string().min(1).max(128) }).openapi('UnlockRequest');
export const RequestCodeBody = z.object({ email: z.string().trim().email().max(255) }).openapi('ShareCodeRequest');
export const VerifyCodeBody = z
  .object({
    email: z.string().trim().email().max(255),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
  })
  .openapi('ShareCodeVerifyRequest');

const linkState = {
  allowDownload: z.boolean(),
  allowedEmails: z.array(z.string()),
};

export const ShareActivity = obj({
  opens: z.number().int(),
  downloads: z.number().int(),
  distinctViewers: z
    .number()
    .int()
    .openapi({ description: 'Estimate: NAT merges viewers, network changes split them.' }),
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
  ...linkState,
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
    ...linkState,
  }),
});
export const ShareUpdatedResponse = obj({
  share: obj({
    id: uuid,
    expiresAt: timestamp.nullable(),
    hasPassword: z.boolean(),
    maxDownloads: z.number().int().nullable(),
    downloadCount: z.number().int(),
    ...linkState,
  }),
});

export const ShareOutcome = z
  .enum(['resolved', 'downloaded', 'expired', 'revoked', 'document_deleted', 'exhausted', 'bad_password', 'bad_code'])
  .openapi('ShareOutcome');
export const ShareEventsResponse = obj({
  events: z.array(
    obj({
      accessedAt: timestamp,
      outcome: ShareOutcome,
      userAgent: z.string().nullable(),
      viewer: z
        .string()
        .regex(/^[0-9a-f]{8}$/)
        .openapi({ description: 'Opaque marker for "the same viewer". Never an address.' }),
      email: z
        .string()
        .nullable()
        .openapi({ description: 'The address the viewer proved, on a link restricted to named people.' }),
    }),
  ),
});

export const PublicShareResponse = z
  .union([
    obj({
      locked: z.literal(true),
      requiresEmail: z.boolean().openapi({ description: 'Confirm an address on the link with a one-time code.' }),
      requiresPassword: z.boolean(),
      expiresAt: timestamp.nullable(),
    }),
    obj({
      locked: z.literal(false),
      passwordProtected: z.boolean(),
      restricted: z.boolean(),
      viewerEmail: z.string().nullable(),
      allowDownload: z.boolean(),
      previewable: z.boolean().openapi({ description: 'GET /api/shares/{token}/content can show it in the page.' }),
      watermark: z
        .string()
        .nullable()
        .openapi({ description: 'On a view-only link: the text stamped on the file, to overlay on images.' }),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number().int(),
      expiresAt: timestamp.nullable(),
      downloadsRemaining: z.number().int().nullable(),
    }),
  ])
  .openapi('PublicShare');
