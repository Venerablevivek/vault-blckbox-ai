import type { Mailer } from '../mail/mailer';
import type { Services } from '../services';
import type { JobHandlers } from './queue';

/** What each queue does. The worker runs these; tests run them through the same queue. */
export function createJobHandlers(services: Services, mailer: Mailer): JobHandlers {
  return {
    'email.send': async (message) => mailer.send(message),
    'notifications.fanout': async (payload) => services.notifications.fanOut(payload),
    'document.checksum': async ({ documentId }) => services.documents.computeChecksum(documentId),
    'document.scan': async ({ documentId }) => services.documents.scanDocument(documentId),
    'workspace.purge': async ({ workspaceId }) => {
      await services.documents.purgeWorkspace(workspaceId);
    },
    'maintenance.run': async () => {
      await services.maintenance.runOnce();
    },
  };
}
