import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Rate-limit counters are shared and survive API restarts, so a second run of the suite from the
 * same address would start rate limited. Clear them first. Set E2E_RESET_RATE_LIMITS=false to run
 * against an environment you don't control.
 */
export default function globalSetup(): void {
  if (process.env.E2E_RESET_RATE_LIMITS === 'false') return;
  resetRateLimits();
}

export function resetRateLimits(): void {
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'filesharing',
      '-d',
      'filesharing',
      '-q',
      '-c',
      'DELETE FROM rate_limits',
    ],
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );
}
