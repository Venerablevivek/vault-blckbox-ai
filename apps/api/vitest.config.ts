import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests share one Postgres database and one MinIO bucket.
    // Running files in a single process keeps truncation between tests deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: [],
  },
});
