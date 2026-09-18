import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque bearer tokens for sessions, share links and invitations.
 *
 * 32 random bytes = 256 bits of entropy. Deliberately NOT a UUID: a UUIDv4 carries
 * only 122 bits and is structured, and it should never be possible to confuse a
 * capability token with an internal identifier.
 *
 * Only the SHA-256 hash is ever stored. Tokens are bearer secrets, so they are
 * treated like passwords: shown once, hashed at rest, and redacted from logs.
 */
const TOKEN_BYTES = 32;

export type TokenPrefix = 'shr' | 'fsh' | 'inv' | 'ses' | 'pwr' | 'evt';

export function generateToken(prefix: TokenPrefix): string {
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time compare for hashes of equal length. */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * IP addresses are stored (where they are stored at all) as a keyed hash so they can
 * be correlated for abuse detection without retaining a personally identifying value.
 */
export function hashIp(ip: string, pepper: string): Buffer {
  return createHash('sha256').update(`${pepper}:${ip}`, 'utf8').digest();
}
