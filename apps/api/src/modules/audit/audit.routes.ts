import type { FastifyInstance } from 'fastify';
import { AuditQuery } from '../../contracts/activity';
import { WorkspaceParams } from '../../contracts/workspaces';
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
      const { id } = WorkspaceParams.parse(request.params);
      const query = AuditQuery.parse(request.query);

      const user = currentUser(request);
      const membership = await workspaces.requireMember(id, user.id);
      requireOwner(membership.role);

      return { events: await audit.list(id, query) };
    },
  });
}
