import { describe, expect, it } from 'vitest';
import { Permissions, requireOwner } from '../../src/policy';
import { AppError } from '../../src/lib/errors';

const OWNER_ID = 'owner-user';
const MEMBER_ID = 'member-user';

/**
 * The whole permission model, asserted cell by cell. Two roles keeps this table small
 * enough to be exhaustive rather than representative.
 */
describe('permission matrix', () => {
  it('lets only an OWNER invite', () => {
    expect(Permissions.canInvite('OWNER')).toBe(true);
    expect(Permissions.canInvite('MEMBER')).toBe(false);
    expect(() => requireOwner('MEMBER')).toThrow(AppError);
    expect(() => requireOwner('OWNER')).not.toThrow();
  });

  it('lets both roles upload', () => {
    expect(Permissions.canUpload('OWNER')).toBe(true);
    expect(Permissions.canUpload('MEMBER')).toBe(true);
  });

  it('lets a MEMBER delete only their own documents', () => {
    expect(Permissions.canDeleteDocument('MEMBER', MEMBER_ID, MEMBER_ID)).toBe(true);
    expect(Permissions.canDeleteDocument('MEMBER', OWNER_ID, MEMBER_ID)).toBe(false);
  });

  it('lets an OWNER delete anything in the workspace', () => {
    expect(Permissions.canDeleteDocument('OWNER', MEMBER_ID, OWNER_ID)).toBe(true);
  });

  it('applies the same ownership rule to share revocation', () => {
    expect(Permissions.canRevokeShare('MEMBER', MEMBER_ID, MEMBER_ID)).toBe(true);
    expect(Permissions.canRevokeShare('MEMBER', OWNER_ID, MEMBER_ID)).toBe(false);
    expect(Permissions.canRevokeShare('OWNER', MEMBER_ID, OWNER_ID)).toBe(true);
  });
});
