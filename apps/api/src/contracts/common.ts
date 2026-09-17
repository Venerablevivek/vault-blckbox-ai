import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * API contracts: the single source for request validation (routes parse with these), response
 * shapes (contract tests validate real responses against them) and the OpenAPI document
 * (generated from them). A field can't be added to a response without the spec and the web
 * client's generated types changing with it.
 */
extendZodWithOpenApi(z);

export { z };

/** Response objects reject unknown keys, so a contract test fails when a response grows a field the spec lacks. */
export const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const uuid = z.string().uuid();
export const timestamp = z.string().datetime().openapi({ example: '2026-09-17T10:15:00.000Z' });
export const Role = z.enum(['OWNER', 'MEMBER', 'VIEWER']).openapi('Role');

export const ErrorBody = obj({
  error: obj({
    code: z.string().openapi({ example: 'NOT_FOUND' }),
    message: z.string(),
    details: z
      .array(obj({ path: z.string(), message: z.string() }))
      .optional()
      .openapi({ description: 'Per-field problems, for VALIDATION_FAILED.' }),
  }),
}).openapi('Error');

export const StorageUsage = obj({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
}).openapi('StorageUsage');

export const idParam = obj({ id: uuid });
