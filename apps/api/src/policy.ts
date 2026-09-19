import { Errors } from './lib/errors';
import type { Role } from './types';

/**
 * The entire authorization model, in one file.
 *
 *  Action                                   OWNER   MEMBER     VIEWER
 *  list, preview, download documents          x        x          x
 *  list members, browse folders               x        x          x
 *  upload, create folders                     x        x          -
 *  create share links                         x        x          -
 *  rename / move / trash / restore document   x     own only      -
 *  rename / move / delete folder              x     own only      -
 *  edit / revoke share link                   x     own only      -
 *  comment on documents                       x        x          x
 *  edit a comment                            own      own        own
 *  delete a comment                           x     own only   own only
 *  permanently delete from trash              x        -          -
 *  invite, change roles, remove members       x        -          -
 *  view audit trail, rename workspace         x        -          -
 *  leave workspace                            x*       x          x
 *
 * * an OWNER may leave only while another OWNER remains.
 *
 * "own" means the caller created the row (documents.uploaded_by, folders.created_by,
 * shares.created_by). Ownership only grants rights while the caller is still a MEMBER:
 * someone downgraded to VIEWER cannot keep editing what they created.
 *
 * Commenting is open to VIEWER too: discussing a file doesn't change it or move it anywhere.
 *
 * VIEWER cannot create share links on purpose — a read-only collaborator should not be able
 * to move a document outside the workspace.
 */
const contributor = (role: Role): boolean => role === 'OWNER' || role === 'MEMBER';
const ownsOrAdministers = (role: Role, createdBy: string | null, actorId: string): boolean =>
  role === 'OWNER' || (role === 'MEMBER' && createdBy === actorId);

export const Permissions = {
  canInvite: (role: Role): boolean => role === 'OWNER',
  canManageMembers: (role: Role): boolean => role === 'OWNER',
  canViewAudit: (role: Role): boolean => role === 'OWNER',
  canPurgeDocument: (role: Role): boolean => role === 'OWNER',

  canUpload: contributor,
  canShare: contributor,
  canCreateFolder: contributor,

  /** Rename, move, move to trash and restore all follow the same ownership rule. */
  canModifyDocument: ownsOrAdministers,
  canModifyFolder: ownsOrAdministers,
  /** Editing a link (expiry, password, download limit) follows the same rule as revoking it. */
  canManageShare: ownsOrAdministers,
  /** A comment is its author's to delete; an OWNER may remove any (moderation). */
  canDeleteComment: (role: Role, authorId: string, actorId: string): boolean =>
    role === 'OWNER' || authorId === actorId,
};

export function requireOwner(role: Role): void {
  if (role !== 'OWNER') {
    throw Errors.forbidden('Only the workspace owner can do that.');
  }
}

export function requireContributor(role: Role, action: string): void {
  if (!contributor(role)) {
    throw Errors.forbidden(`Viewers can't ${action}. Ask a workspace owner for member access.`);
  }
}
