import { obj, timestamp, uuid, z } from './common';

export const UploadParams = obj({ id: uuid });

export const CreateUploadBody = z
  .object({
    filename: z.string().min(1).max(255),
    size: z.number().int().positive().openapi({ description: 'Exact size in bytes.' }),
    mimeType: z.string().min(1).max(255),
    folderId: uuid.nullable().optional(),
  })
  .openapi('CreateUploadRequest');

export const SignPartsBody = z
  .object({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100) })
  .openapi('SignPartsRequest');

export const Upload = obj({
  id: uuid,
  filename: z.string(),
  size: z.number().int(),
  folderId: uuid.nullable(),
  partSize: z.number().int().openapi({ description: 'Every part except the last is exactly this many bytes.' }),
  partCount: z.number().int(),
  status: z.enum(['pending', 'completing', 'completed', 'aborted', 'expired', 'rejected']),
  expiresAt: timestamp,
}).openapi('Upload');

export const UploadCreatedResponse = obj({ upload: Upload }).openapi('UploadCreated');
export const SignedPartsResponse = obj({
  parts: z.array(
    obj({
      partNumber: z.number().int(),
      url: z.string().url().openapi({ description: 'PUT the part body here. Read the ETag response header.' }),
    }),
  ),
  expiresAt: timestamp,
}).openapi('SignedParts');
export const UploadStatusResponse = obj({
  upload: Upload,
  uploadedParts: z.array(obj({ partNumber: z.number().int(), size: z.number().int() })),
}).openapi('UploadStatus');
