import { Errors } from './lib/errors';
import type { Role } from './types';

/**
 * The entire authorization model, in one file.
 *
 * Two roles only (the blueprint's decision) keeps this small enough to read in one
 * screen — which is what makes it genuinely reviewable rather than nominally documented.
 *
 *  Action                      OWNER   MEMBER
 *  list documents / members      x        x
 *  upload / download             x        x
 *  create share link             x        x
 *  delete document               x      own only
 *  revoke share link             x      own only
 *  rename document               x      own only
 *  invite / revoke invitation    x        -
 *  change roles, remove members  x        -
 *  rename workspace              x        -
 *  leave workspace               x*       x
 *
 * * an OWNER may leave only while another OWNER remains.
 *
 * "own" means the caller created the row (documents.uploaded_by / shares.created_by).
 */
export const Permissions = {
  /** Only an OWNER may invite people into a workspace. */
  canInvite(role: Role): boolean {
    return role === 'OWNER';
  },

  /** Any member may upload, list and download. */
  canUpload(role: Role): boolean {
    return role === 'OWNER' || role === 'MEMBER';
  },

  /** A MEMBER may delete only what they uploaded; an OWNER may delete anything. */
  canDeleteDocument(role: Role, uploadedBy: string, actorId: string): boolean {
    return role === 'OWNER' || uploadedBy === actorId;
  },

  /** Same ownership rule as deletion: your own documents, or any if you own the workspace. */
  canRenameDocument(role: Role, uploadedBy: string, actorId: string): boolean {
    return role === 'OWNER' || uploadedBy === actorId;
  },

  /** A MEMBER may revoke only links they created; an OWNER may revoke any link. */
  canRevokeShare(role: Role, createdBy: string, actorId: string): boolean {
    return role === 'OWNER' || createdBy === actorId;
  },
};

export function requireOwner(role: Role): void {
  if (!Permissions.canInvite(role)) {
    throw Errors.forbidden('Only the workspace owner can do that.');
  }
}
