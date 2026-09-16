import argon2 from 'argon2';

/**
 * Argon2id with OWASP-baseline parameters. Argon2 is memory-hard, which is what makes
 * offline cracking of a leaked hash expensive.
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * A precomputed hash used to burn the same CPU time when an email does not exist.
 * Without it, login response time tells an attacker which addresses are registered.
 */
let dummyHash: string | null = null;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** Runs a verify against a throwaway hash so timing does not leak account existence. */
export async function burnVerifyTime(plain: string): Promise<void> {
  if (!dummyHash) dummyHash = await argon2.hash('unused-placeholder-password', OPTIONS);
  await argon2.verify(dummyHash, plain).catch(() => undefined);
}
