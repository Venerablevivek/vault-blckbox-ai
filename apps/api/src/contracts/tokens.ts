import { obj, timestamp, uuid, z } from './common';

export const TokenParams = obj({ id: uuid });

export const CreateTokenBody = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ description: 'What the token is for, e.g. "backup script".' }),
    scopes: z
      .array(z.enum(['read', 'write']))
      .min(1)
      .max(2)
      .openapi({ description: 'read: GET requests only. write: everything the account can do (write includes read).' }),
    expiresInDays: z.number().int().min(1).max(365).nullable().optional().openapi({ description: 'null = never.' }),
  })
  .openapi('CreateTokenRequest');

export const ApiToken = obj({
  id: uuid,
  name: z.string(),
  prefix: z.string().openapi({ description: 'The first characters of the token, to tell tokens apart.' }),
  scopes: z.array(z.enum(['read', 'write'])),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
}).openapi('ApiToken');

export const TokensResponse = obj({ tokens: z.array(ApiToken) });
export const TokenCreatedResponse = obj({
  token: ApiToken.extend({
    secret: z.string().openapi({ description: 'Send as "Authorization: Bearer <secret>". Returned only here, once.' }),
  }),
});
