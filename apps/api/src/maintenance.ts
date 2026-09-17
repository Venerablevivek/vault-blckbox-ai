import path from 'node:path';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { buildLoggerOptions, pino } from './lib/logger';
import { createServices } from './services';
import { S3Storage } from './storage/s3-storage';
import { systemClock } from './types';

/**
 * Runs one cleanup pass and exits. The worker schedules this automatically; this entry point is
 * for running it on demand:  docker compose exec worker node dist/maintenance.js
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(buildLoggerOptions(config.NODE_ENV));
  const pool = createPool(config.DATABASE_URL);
  await runMigrations(pool, path.resolve(__dirname, '../migrations'), logger);

  const storage = S3Storage.fromConfig(config);
  const services = createServices({ config, pool, storage, multipartStorage: storage, logger, clock: systemClock });
  const result = await services.maintenance.runOnce();
  console.log(JSON.stringify(result ?? { skipped: 'another instance is running maintenance' }));
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Maintenance failed:', error);
  process.exit(1);
});
