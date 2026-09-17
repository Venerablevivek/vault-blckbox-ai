import { describe, expect, it } from 'vitest';
import { Permissions, requireContributor, requireOwner } from '../../src/policy';
import { AppError } from '../../src/lib/errors';
import type { Role } from '../../src/types';

const ME = 'me';
const SOMEONE_ELSE = 'someone-else';
const ROLES: Role[] = ['OWNER', 'MEMBER', 'VIEWER'];

/**
 * The whole permission model, asserted cell by cell for all three roles. Small enough to be
 * exhaustive rather than representative.
 */
describe('permission matrix', () => {
  it('reserves people management, audit and permanent delete for owners', () => {
    for (const role of ROLES) {
      const owner = role === 'OWNER';
      expect(Permissions.canInvite(role)).toBe(owner);
      expect(Permissions.canManageMembers(role)).toBe(owner);
      expect(Permissions.canViewAudit(role)).toBe(owner);
      expect(Permissions.canPurgeDocument(role)).toBe(owner);
    }
    expect(() => requireOwner('MEMBER')).toThrow(AppError);
    expect(() => requireOwner('VIEWER')).toThrow(AppError);
    expect(() => requireOwner('OWNER')).not.toThrow();
  });

  it('lets owners and members contribute, and viewers only read', () => {
    for (const role of ROLES) {
      const contributor = role !== 'VIEWER';
      expect(Permissions.canUpload(role)).toBe(contributor);
      expect(Permissions.canShare(role)).toBe(contributor);
      expect(Permissions.canCreateFolder(role)).toBe(contributor);
    }
    expect(() => requireContributor('VIEWER', 'upload')).toThrow(/Viewers can't upload/);
    expect(() => requireContributor('MEMBER', 'upload')).not.toThrow();
  });

  it('lets a member change only what they created', () => {
    for (const check of [Permissions.canModifyDocument, Permissions.canModifyFolder, Permissions.canManageShare]) {
      expect(check('MEMBER', ME, ME)).toBe(true);
      expect(check('MEMBER', SOMEONE_ELSE, ME)).toBe(false);
    }
  });

  it('lets an owner change anything', () => {
    for (const check of [Permissions.canModifyDocument, Permissions.canModifyFolder, Permissions.canManageShare]) {
      expect(check('OWNER', SOMEONE_ELSE, ME)).toBe(true);
      expect(check('OWNER', null, ME)).toBe(true);
    }
  });

  it('gives a viewer no rights over what they created before being downgraded', () => {
    for (const check of [Permissions.canModifyDocument, Permissions.canModifyFolder, Permissions.canManageShare]) {
      expect(check('VIEWER', ME, ME)).toBe(false);
    }
  });
});
