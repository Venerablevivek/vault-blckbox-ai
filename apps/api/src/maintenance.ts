import path from 'node:path';
import { loadConfig } from './config';
import { createDatabase } from './db/pool';
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
  const db = createDatabase(config, 'vault-maintenance');
  const { pool } = db;
  if (config.MIGRATE_ON_START) await runMigrations(db.directPool, path.resolve(__dirname, '../migrations'), logger);

  const storage = S3Storage.fromConfig(config);
  const services = createServices({
    config,
    pool,
    directPool: db.directPool,
    readPool: db.readPool,
    storage,
    multipartStorage: storage,
    logger,
    clock: systemClock,
  });
  const result = await services.maintenance.runOnce();
  console.log(JSON.stringify(result ?? { skipped: 'another instance is running maintenance' }));
  await db.end();
}

main().catch((error: unknown) => {
  console.error('Maintenance failed:', error);
  process.exit(1);
});
