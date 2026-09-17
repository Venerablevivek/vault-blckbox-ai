import type { FastifyInstance } from 'fastify';
import {
  CreateFolderBody,
  FolderParams,
  ListFoldersQuery,
  UpdateFolderBody,
  WorkspaceDocumentsParams,
} from '../../contracts/documents';
import { currentUser, requireSession } from '../../plugins/session';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import { toFolderDto, type FoldersService } from './folders.service';


export function registerFolderRoutes(
  app: FastifyInstance,
  deps: { folders: FoldersService; workspaces: WorkspacesService },
): void {
  const { folders, workspaces } = deps;

  // Every route authorizes membership before reading the body, so a non-member always gets 404.

  app.get('/api/workspaces/:workspaceId/folders', { preHandler: requireSession }, async (request) => {
    const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
    const membership = await workspaces.requireMember(workspaceId, currentUser(request).id);
    const { parentId } = ListFoldersQuery.parse(request.query);
    const result = await folders.list(membership, parentId ?? null);
    return { path: result.path.map(toFolderDto), folders: result.children.map(toFolderDto) };
  });

  app.post('/api/workspaces/:workspaceId/folders', { preHandler: requireSession }, async (request, reply) => {
    const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(workspaceId, user.id);
    const body = CreateFolderBody.parse(request.body);
    const folder = await folders.create(membership, user.id, body);
    return reply.status(201).send({ folder: toFolderDto(folder) });
  });

  app.patch('/api/workspaces/:workspaceId/folders/:folderId', { preHandler: requireSession }, async (request) => {
    const { workspaceId, folderId } = FolderParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(workspaceId, user.id);
    const body = UpdateFolderBody.parse(request.body);
    const folder = await folders.update(membership, user.id, folderId, body);
    return { folder: toFolderDto(folder) };
  });

  app.delete('/api/workspaces/:workspaceId/folders/:folderId', { preHandler: requireSession }, async (request, reply) => {
    const { workspaceId, folderId } = FolderParams.parse(request.params);
    const user = currentUser(request);
    const membership = await workspaces.requireMember(workspaceId, user.id);
    await folders.remove(membership, user.id, folderId);
    return reply.status(204).send();
  });
}
