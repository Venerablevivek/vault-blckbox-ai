import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Errors } from '../../lib/errors';
import { Permissions, requireContributor } from '../../policy';
import type { Membership } from '../../types';
import type { AuditService } from '../audit/audit.service';
import { foldersRepo, MAX_FOLDER_DEPTH, type FolderRow } from './folders.repo';
import { stripControlCharacters } from '../../lib/text';
import { withTenant } from '../../db/tenant';

function cleanName(name: string): string {
  const clean = stripControlCharacters(name).trim();
  if (!clean) throw Errors.badRequest('INVALID_NAME', 'A folder needs a name.');
  if (/[\\/]/.test(clean)) throw Errors.badRequest('INVALID_NAME', 'Folder names cannot contain / or \\.');
  return clean;
}

/** Postgres unique violation, turned into a friendly conflict instead of a 500. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

export function toFolderDto(f: FolderRow & { document_count?: string; folder_count?: string }) {
  return {
    id: f.id,
    name: f.name,
    parentId: f.parent_id,
    createdBy: f.created_by,
    createdAt: f.created_at,
    ...(f.document_count !== undefined
      ? { documentCount: Number(f.document_count), folderCount: Number(f.folder_count) }
      : {}),
  };
}

export function createFoldersService(deps: { pool: Pool; audit: AuditService }) {
  const { pool, audit } = deps;

  /** Workspace-scoped lookup. A folder from another workspace is indistinguishable from none. */
  async function requireFolder(workspaceId: string, id: string): Promise<FolderRow> {
    const folder = await foldersRepo.findInWorkspace(pool, workspaceId, id);
    if (!folder) throw Errors.notFound('Folder');
    return folder;
  }

  return {
    requireFolder,

    async list(membership: Membership, userId: string, parentId: string | null) {
      return withTenant(pool, userId, async (db) => {
        const path = parentId ? await foldersRepo.pathTo(db, membership.workspaceId, parentId) : [];
        if (parentId && path.length === 0) throw Errors.notFound('Folder');
        const children = await foldersRepo.listChildren(db, membership.workspaceId, parentId);
        return { path, children };
      });
    },

    async create(membership: Membership, userId: string, input: { name: string; parentId: string | null }) {
      requireContributor(membership.role, 'create folders');
      const name = cleanName(input.name);

      if (input.parentId) {
        const path = await foldersRepo.pathTo(pool, membership.workspaceId, input.parentId);
        if (path.length === 0) throw Errors.notFound('Folder');
        if (path.length >= MAX_FOLDER_DEPTH) {
          throw Errors.unprocessable(
            'FOLDER_TOO_DEEP',
            `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
          );
        }
      }

      try {
        const folder = await foldersRepo.insert(pool, {
          id: randomUUID(),
          workspaceId: membership.workspaceId,
          parentId: input.parentId,
          name,
          createdBy: userId,
        });
        await audit.record({
          workspaceId: membership.workspaceId,
          actorUserId: userId,
          action: 'folder.created',
          resourceType: 'folder',
          resourceId: folder.id,
          metadata: { name },
        });
        return folder;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw Errors.conflict('FOLDER_NAME_TAKEN', `A folder called "${name}" already exists here.`);
        }
        throw error;
      }
    },

    /**
     * Renames and/or moves a folder.
     *
     * A move is rejected if the destination is the folder itself or anything beneath it,
     * because the tree would then contain a cycle and its contents would become unreachable.
     * It is also rejected if the result would nest deeper than MAX_FOLDER_DEPTH.
     */
    async update(
      membership: Membership,
      userId: string,
      id: string,
      input: { name?: string; parentId?: string | null },
    ) {
      const folder = await requireFolder(membership.workspaceId, id);
      if (!Permissions.canModifyFolder(membership.role, folder.created_by, userId)) {
        throw Errors.forbidden("Only the folder's creator or a workspace owner can change it.");
      }

      const name = input.name !== undefined ? cleanName(input.name) : undefined;
      const moving = input.parentId !== undefined && input.parentId !== folder.parent_id;

      if (moving && input.parentId) {
        const destination = await foldersRepo.pathTo(pool, membership.workspaceId, input.parentId);
        if (destination.length === 0) throw Errors.notFound('Folder');
        if (destination.some((ancestor) => ancestor.id === folder.id)) {
          throw Errors.unprocessable('FOLDER_CYCLE', 'A folder cannot be moved inside itself.');
        }
        const height = await foldersRepo.subtreeHeight(pool, folder.id);
        if (destination.length + 1 + height > MAX_FOLDER_DEPTH) {
          throw Errors.unprocessable(
            'FOLDER_TOO_DEEP',
            `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
          );
        }
      }

      try {
        const updated = await foldersRepo.update(pool, id, {
          name,
          parentId: moving ? input.parentId : undefined,
        });
        if (name !== undefined && name !== folder.name) {
          await audit.record({
            workspaceId: membership.workspaceId,
            actorUserId: userId,
            action: 'folder.renamed',
            resourceType: 'folder',
            resourceId: id,
            metadata: { from: folder.name, to: name },
          });
        }
        if (moving) {
          await audit.record({
            workspaceId: membership.workspaceId,
            actorUserId: userId,
            action: 'folder.moved',
            resourceType: 'folder',
            resourceId: id,
            metadata: { name: updated.name },
          });
        }
        return updated;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw Errors.conflict('FOLDER_NAME_TAKEN', 'A folder with that name already exists there.');
        }
        throw error;
      }
    },

    /**
     * Deletes an empty folder. Refusing non-empty folders means a folder delete can never
     * take documents with it by surprise: the user moves or trashes the contents first.
     */
    async remove(membership: Membership, userId: string, id: string) {
      const folder = await requireFolder(membership.workspaceId, id);
      if (!Permissions.canModifyFolder(membership.role, folder.created_by, userId)) {
        throw Errors.forbidden("Only the folder's creator or a workspace owner can delete it.");
      }
      if (!(await foldersRepo.isEmpty(pool, id))) {
        throw Errors.conflict('FOLDER_NOT_EMPTY', "Move or delete what's inside this folder first.");
      }
      await foldersRepo.delete(pool, id);
      await audit.record({
        workspaceId: membership.workspaceId,
        actorUserId: userId,
        action: 'folder.deleted',
        resourceType: 'folder',
        resourceId: id,
        metadata: { name: folder.name },
      });
    },
  };
}

export type FoldersService = ReturnType<typeof createFoldersService>;
