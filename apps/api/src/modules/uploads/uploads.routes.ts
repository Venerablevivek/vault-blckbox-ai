import type { FastifyInstance } from 'fastify';
import { WorkspaceDocumentsParams } from '../../contracts/documents';
import { CreateUploadBody, SignPartsBody, UploadParams } from '../../contracts/uploads';
import { Errors } from '../../lib/errors';
import { currentUser, requireSession } from '../../plugins/session';
import { toDocumentDto } from '../documents/documents.routes';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import { toUploadDto, type UploadsService } from './uploads.service';

/**
 * Direct uploads: the browser uploads file parts straight to object storage with signed URLs,
 * and these routes open, resume, complete or abort the upload. Membership is checked before the
 * body is read, like every other workspace route.
 */
export function registerUploadRoutes(
  app: FastifyInstance,
  deps: { uploads: UploadsService | null; workspaces: WorkspacesService },
): void {
  const { workspaces } = deps;
  const uploads = () => {
    if (!deps.uploads) throw Errors.notImplemented('Direct uploads need S3-compatible storage.');
    return deps.uploads;
  };

  app.post('/api/workspaces/:workspaceId/uploads', {
    preHandler: requireSession,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { workspaceId } = WorkspaceDocumentsParams.parse(request.params);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(workspaceId, user.id);
      const body = CreateUploadBody.parse(request.body);
      const upload = await uploads().create({ membership, userId: user.id, ...body, folderId: body.folderId ?? null });
      return reply.status(201).send({ upload: toUploadDto(upload) });
    },
  });

  app.post('/api/uploads/:id/parts', {
    preHandler: requireSession,
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { id } = UploadParams.parse(request.params);
      const { partNumbers } = SignPartsBody.parse(request.body);
      return uploads().signParts(id, currentUser(request).id, partNumbers);
    },
  });

  app.get('/api/uploads/:id', { preHandler: requireSession }, async (request) => {
    const { id } = UploadParams.parse(request.params);
    const { upload, uploadedParts } = await uploads().get(id, currentUser(request).id);
    return { upload: toUploadDto(upload), uploadedParts };
  });

  app.post('/api/uploads/:id/complete', { preHandler: requireSession }, async (request, reply) => {
    const { id } = UploadParams.parse(request.params);
    const { document } = await uploads().complete(id, currentUser(request));
    // Identical-content detection needs the checksum, which the worker computes afterwards.
    return reply.status(201).send({ document: toDocumentDto(document), duplicateOf: null });
  });

  app.delete('/api/uploads/:id', { preHandler: requireSession }, async (request, reply) => {
    const { id } = UploadParams.parse(request.params);
    await uploads().abort(id, currentUser(request).id);
    return reply.status(204).send();
  });
}
