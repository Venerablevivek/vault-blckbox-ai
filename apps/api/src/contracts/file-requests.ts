import { obj, timestamp, uuid, z } from './common';
import { ShareTokenParams } from './shares';

export const FileRequestParams = obj({ id: uuid });
export const FileRequestWorkspaceParams = obj({ workspaceId: uuid });
export const FileRequestTokenParams = ShareTokenParams;

export const CreateFileRequestBody = z
  .object({
    title: z.string().trim().min(1, 'Give the request a title.').max(120),
    message: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .openapi({ description: 'Shown to the person uploading, e.g. what to send.' }),
    folderId: uuid.nullable().optional().openapi({ description: 'Where files land; null or omitted = the top level.' }),
    expiresInDays: z.number().int().min(1).max(90).default(7).openapi({
      description: 'A request always expires: at most 90 days.',
    }),
    maxFiles: z.number().int().min(1).max(500).nullable().optional().openapi({
      description: 'Stop accepting files after this many; null or omitted = no limit.',
    }),
  })
  .openapi('CreateFileRequestRequest');

export const FileRequestSummary = obj({
  id: uuid,
  title: z.string(),
  message: z.string().nullable(),
  folderId: uuid.nullable(),
  folderName: z.string().nullable(),
  createdBy: uuid,
  createdByEmail: z.string(),
  createdAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  maxFiles: z.number().int().nullable(),
  receivedCount: z.number().int(),
  lastReceivedAt: timestamp.nullable(),
  status: z.enum(['open', 'full', 'expired', 'revoked']),
  canManage: z.boolean().openapi({ description: 'The caller made it, or owns the workspace.' }),
}).openapi('FileRequestSummary');

export const FileRequestsResponse = obj({ requests: z.array(FileRequestSummary) });
export const FileRequestCreatedResponse = obj({
  request: FileRequestSummary,
  url: z.string().openapi({ description: 'The upload link. Shown once: only its hash is stored.' }),
});

export const ReceivedFile = obj({
  id: uuid,
  documentId: uuid,
  senderName: z.string(),
  senderEmail: z.string().nullable(),
  filename: z.string(),
  size: z.number().int(),
  receivedAt: timestamp,
}).openapi('ReceivedFile');
export const ReceivedFilesResponse = obj({ files: z.array(ReceivedFile) });

/** What the person holding the link sees. Nothing about the workspace beyond its name. */
export const PublicFileRequest = obj({
  title: z.string(),
  message: z.string().nullable(),
  requestedBy: z.string().openapi({ description: 'Email of the person asking.' }),
  workspaceName: z.string(),
  expiresAt: timestamp,
  remainingFiles: z.number().int().nullable().openapi({ description: 'null = no limit.' }),
  maxFileBytes: z.number().int(),
}).openapi('PublicFileRequest');
export const PublicFileRequestResponse = obj({ request: PublicFileRequest });

export const SenderFields = z.object({
  name: z.string().trim().min(1, 'Tell them who you are.').max(80),
  email: z
    .string()
    .trim()
    .max(255)
    .email('Enter a valid email address, or leave it empty.')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
});
export const FileRequestUploadResponse = obj({
  file: obj({ filename: z.string(), size: z.number().int() }),
  remainingFiles: z.number().int().nullable(),
});
