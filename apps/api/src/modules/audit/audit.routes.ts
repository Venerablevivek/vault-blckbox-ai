import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireSession } from '../../plugins/session';
import { requireOwner } from '../../policy';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { AuditService } from './audit.service';

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: { audit: AuditService; workspaces: WorkspacesService },
): void {
  const { audit, workspaces } = deps;

  /**
   * Workspace activity feed.
   *
   * Owner-only, for the same reason pending invitations are: the trail contains the email
   * addresses of people who were invited and never joined, and the actions of every member.
   * A non-member gets 404; a member without the role gets 403.
   */
  app.get('/api/workspaces/:id/audit', {
    preHandler: requireSession,
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.coerce.date().optional(),
        })
        .parse(request.query);

      const user = currentUser(request);
      const membership = await workspaces.requireMember(id, user.id);
      requireOwner(membership.role);

      return { events: await audit.list(id, query) };
    },
  });
}
