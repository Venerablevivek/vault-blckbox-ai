import { obj, Role, StorageUsage, timestamp, uuid, z } from './common';

export const DocumentParams = obj({ id: uuid });
export const VersionParams = obj({ id: uuid, version: z.coerce.number().int().min(1).max(1_000_000) });
export const WorkspaceDocumentsParams = obj({ workspaceId: uuid });
export const UploadQuery = z.object({ folderId: uuid.optional() });

export const ListDocumentsQuery = z.object({
  view: z.enum(['active', 'trash']).default('active'),
  folderId: uuid.optional(),
  q: z
    .string()
    .max(100)
    .transform((s) => s.trim())
    .optional()
    .openapi({ description: 'Searches file names across the whole workspace (ignores folderId).' }),
  filter: z.enum(['all', 'shared', 'mine', 'starred', 'recent']).default('all').openapi({
    description: 'Everything but all spans the whole workspace. recent is ordered by when you last opened each file.',
  }),
  sort: z.enum(['date', 'name', 'size']).default('date'),
  order: z.enum(['asc', 'desc']).optional().openapi({ description: 'Defaults to asc for name, desc otherwise.' }),
  cursor: z.string().max(500).optional().openapi({ description: 'nextCursor from the previous page.' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const UpdateDocumentBody = z
  .object({
    filename: z.string().min(1).max(255).optional(),
    folderId: uuid.nullable().optional().openapi({ description: 'null moves the document to the workspace root.' }),
  })
  .refine((c) => c.filename !== undefined || c.folderId !== undefined, 'Nothing to change.')
  .openapi('UpdateDocumentRequest');

export const Folder = obj({
  id: uuid,
  name: z.string(),
  parentId: uuid.nullable(),
  createdBy: uuid.nullable(),
  createdAt: timestamp,
  documentCount: z.number().int().optional(),
  folderCount: z.number().int().optional(),
}).openapi('Folder');

export const Document = obj({
  id: uuid,
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .openapi({ description: 'Hex SHA-256 of the stored bytes; null only while an older file is backfilled.' }),
  scanStatus: z.enum(['pending', 'clean', 'infected', 'unscanned']).openapi({
    description:
      'pending: being checked for malware (not downloadable yet). infected: removed. unscanned: not scanned (scanning off, too large, or uploaded before scanning).',
  }),
  folderId: uuid.nullable(),
  uploadedBy: uuid,
  uploadedByEmail: z.string().optional().openapi({ description: 'Present in listings.' }),
  createdAt: timestamp,
  deletedAt: timestamp.nullable(),
  deletedByEmail: z.string().nullable(),
  starred: z.boolean().optional().openapi({ description: 'Whether you starred it. Present in listings.' }),
  version: z.number().int().min(1).openapi({ description: 'The current version; earlier ones are in /versions.' }),
  links: obj({ count: z.number().int(), opens: z.number().int(), lastAccessedAt: timestamp.nullable() })
    .optional()
    .openapi({ description: 'Rollup of live share links. Present in listings.' }),
}).openapi('Document');

export const DocumentResponse = obj({ document: Document });

export const DocumentVersion = obj({
  version: z.number().int().min(1),
  current: z.boolean(),
  filename: z.string().openapi({ description: 'The name the document had when this version was current.' }),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  scanStatus: z.enum(['pending', 'clean', 'infected', 'unscanned']),
  uploadedBy: uuid,
  uploadedByEmail: z.string(),
  createdAt: timestamp.openapi({ description: 'When this version was uploaded.' }),
}).openapi('DocumentVersion');
export const VersionsResponse = obj({ versions: z.array(DocumentVersion) }).openapi('DocumentVersions');
export const UploadResponse = obj({
  document: Document,
  duplicateOf: obj({ id: uuid, filename: z.string() })
    .nullable()
    .openapi({ description: 'A live document in the workspace with identical content.' }),
}).openapi('UploadResult');
export const DocumentListResponse = obj({
  role: Role,
  documents: z.array(Document),
  nextCursor: z.string().nullable(),
  folders: z.array(Folder),
  path: z.array(Folder),
  counts: obj({
    all: z.number().int(),
    shared: z.number().int(),
    mine: z.number().int(),
    starred: z.number().int(),
    trash: z.number().int(),
  })
    .nullable()
    .openapi({ description: 'Tab counts for the whole workspace; null on pages after the first.' }),
  storage: StorageUsage,
  trashRetentionDays: z.number().int(),
}).openapi('DocumentList');
/** At most this many documents in one bulk request or zip selection. */
export const MAX_BATCH = 100;

const documentIds = z
  .array(uuid)
  .min(1)
  .max(MAX_BATCH)
  .refine((ids) => new Set(ids).size === ids.length, 'List each document once.');

export const BulkDocumentsBody = z
  .object({
    action: z.enum(['trash', 'restore', 'delete', 'move']).openapi({
      description: 'delete permanently removes documents already in the trash (owners only).',
    }),
    ids: documentIds,
    folderId: uuid.nullable().optional().openapi({ description: 'Where move puts them; null is the workspace root.' }),
  })
  .refine((b) => b.action !== 'move' || b.folderId !== undefined, {
    message: 'Say where to move the documents (folderId, or null for the root).',
    path: ['folderId'],
  })
  .openapi('BulkDocumentsRequest');

export const BulkDocumentsResponse = obj({
  results: z.array(
    obj({
      id: uuid,
      ok: z.boolean(),
      error: obj({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).openapi('BulkDocumentsResult');

export const ArchiveQuery = z.object({
  ids: z
    .string()
    .max(4000)
    .transform((value, ctx) => {
      const ids = value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length === 0 || ids.length > MAX_BATCH || !ids.every((id) => uuid.safeParse(id).success)) {
        ctx.addIssue({ code: 'custom', message: `Give 1 to ${MAX_BATCH} comma-separated document ids.` });
        return z.NEVER;
      }
      return [...new Set(ids)];
    })
    .optional()
    .openapi({ description: `Comma-separated document ids, up to ${MAX_BATCH}. Give this or folderId.` }),
  folderId: uuid.optional().openapi({ description: 'Download this folder and everything below it.' }),
});

export const ArchiveSummaryResponse = obj({
  filename: z.string(),
  files: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  skipped: z
    .number()
    .int()
    .nonnegative()
    .openapi({ description: 'Chosen files left out because the malware scan has not cleared them.' }),
}).openapi('ArchiveSummary');

export const TrashResponse = obj({ revokedLinks: z.number().int().nonnegative(), purgeAt: timestamp });

export const FolderParams = obj({ workspaceId: uuid, folderId: uuid });
export const ListFoldersQuery = z.object({ parentId: uuid.optional() });
export const CreateFolderBody = z
  .object({ name: z.string().min(1).max(120), parentId: uuid.nullable().default(null) })
  .openapi('CreateFolderRequest');
export const UpdateFolderBody = z
  .object({ name: z.string().min(1).max(120).optional(), parentId: uuid.nullable().optional() })
  .refine((b) => b.name !== undefined || b.parentId !== undefined, 'Nothing to change.')
  .openapi('UpdateFolderRequest');
export const FolderResponse = obj({ folder: Folder });
export const FoldersResponse = obj({ path: z.array(Folder), folders: z.array(Folder) });
