import { describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../../src/lib/tokens';

describe('capability tokens', () => {
  it('carries 256 bits of entropy in a URL-safe encoding', () => {
    const token = generateToken('shr');
    const body = token.slice('shr_'.length);
    // 32 random bytes in base64url is 43 characters.
    expect(body).toHaveLength(43);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats across many generations', () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateToken('shr')));
    expect(tokens.size).toBe(2000);
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateToken('inv');
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
    expect(hashToken(token).toString('hex')).not.toContain(token);
    expect(hashToken(token)).toHaveLength(32);
  });
});
