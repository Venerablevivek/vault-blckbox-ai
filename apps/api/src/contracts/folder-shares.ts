import { obj, timestamp, uuid, z } from './common';
import { ShareTokenParams } from './shares';

export const FolderShareIdParams = obj({ id: uuid });
export const WorkspaceFolderParams = obj({ workspaceId: uuid, folderId: uuid });
export const FolderShareDocumentParams = ShareTokenParams.extend({ documentId: uuid });
export const FolderShareBrowseQuery = z.object({
  folderId: uuid.optional().openapi({ description: 'A folder inside the shared one; defaults to the shared folder.' }),
});

export const CreateFolderShareBody = z
  .object({
    folderId: uuid,
    expiresInHours: z
      .number()
      .int()
      .positive()
      .max(8760)
      .nullable()
      .optional()
      .openapi({ description: 'null = never expires; omitted = the default.' }),
    password: z.string().min(6).max(128).nullable().optional(),
  })
  .openapi('CreateFolderShareRequest');

export const FolderShareSummary = obj({
  id: uuid,
  createdBy: uuid,
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  hasPassword: z.boolean(),
  opens: z.number().int(),
  downloads: z.number().int(),
  lastAccessedAt: timestamp.nullable(),
}).openapi('FolderShareSummary');

export const FolderSharesResponse = obj({ shares: z.array(FolderShareSummary) });
export const FolderShareCreatedResponse = obj({
  share: obj({
    id: uuid,
    url: z.string().url().openapi({ description: 'Contains the token. Returned only here, once.' }),
    expiresAt: timestamp.nullable(),
    createdAt: timestamp,
    hasPassword: z.boolean(),
  }),
});

export const PublicFolderShareResponse = z
  .union([
    obj({ locked: z.literal(true), expiresAt: timestamp.nullable() }),
    obj({
      locked: z.literal(false),
      name: z.string().openapi({ description: 'The shared folder.' }),
      expiresAt: timestamp.nullable(),
      passwordProtected: z.boolean(),
      path: z
        .array(obj({ id: uuid, name: z.string() }))
        .openapi({ description: 'From the shared folder down to the one shown.' }),
      folders: z.array(
        obj({ id: uuid, name: z.string(), documentCount: z.number().int(), folderCount: z.number().int() }),
      ),
      documents: z.array(
        obj({ id: uuid, filename: z.string(), mimeType: z.string(), size: z.number().int(), createdAt: timestamp }),
      ),
      truncated: z
        .boolean()
        .openapi({ description: 'More than 500 folders or files here; only the first are listed.' }),
    }),
  ])
  .openapi('PublicFolderShare');
