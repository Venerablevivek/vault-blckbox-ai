import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { AuditExportQuery, AuditQuery } from '../../contracts/activity';
import { CSV_BOM, csvRow } from '../../lib/csv';
import { attachmentDisposition } from '../documents/documents.routes';
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

      return audit.list(id, user.id, query);
    },
  });

  /**
   * The trail (or the filtered part of it) as CSV, streamed a batch at a time. Each row carries
   * its hash, so an exported copy can later be checked against the chain.
   */
  app.get('/api/workspaces/:id/audit/export', {
    preHandler: requireSession,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { id } = WorkspaceParams.parse(request.params);
      const filter = AuditExportQuery.parse(request.query);
      const user = currentUser(request);
      const membership = await workspaces.requireMember(id, user.id);
      requireOwner(membership.role);

      async function* lines() {
        yield CSV_BOM +
          csvRow(['time_utc', 'actor', 'action', 'resource_type', 'resource_id', 'file', 'details', 'hash']);
        for await (const row of audit.exportRows(id, user.id, filter)) {
          const { filename, ...details } = row.metadata as { filename?: unknown };
          yield csvRow([
            row.created_at.toISOString(),
            row.actor_email ?? '',
            row.action,
            row.resource_type,
            row.resource_id,
            typeof filename === 'string' ? filename : '',
            Object.keys(details).length ? JSON.stringify(details) : '',
            row.hash ? row.hash.toString('hex') : '',
          ]);
        }
      }
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', attachmentDisposition(`activity-${new Date().toISOString().slice(0, 10)}.csv`))
        .header('Cache-Control', 'private, no-store')
        .send(Readable.from(lines()));
    },
  });

  // Recomputes the workspace's audit hash chain. Owner-only, like the trail itself.
  app.get('/api/workspaces/:id/audit/verify', {
    preHandler: requireSession,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { id } = WorkspaceParams.parse(request.params);
      const membership = await workspaces.requireMember(id, currentUser(request).id);
      requireOwner(membership.role);
      return audit.verifyChain(id);
    },
  });
}
