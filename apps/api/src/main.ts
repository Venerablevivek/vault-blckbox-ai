import path from 'node:path';
import { loadConfig } from './config';
import { createDatabase } from './db/pool';
import { runMigrations } from './db/migrate';
import { buildLoggerOptions, pino } from './lib/logger';
import { seedDemoData } from './seed';
import { S3Storage } from './storage/s3-storage';
import { buildApp } from './server';

/**
 * The only place that touches process.env, opens sockets, or has side effects.
 *
 * Boot order matters: migrate the schema and make sure the bucket exists BEFORE the
 * server accepts traffic, so `docker compose up --build` needs no manual setup step and
 * the first request can never hit a half-initialised system.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(buildLoggerOptions(config.NODE_ENV));

  const db = createDatabase(config, 'vault-api');
  const { pool } = db;
  const storage = S3Storage.fromConfig(config);

  if (config.MIGRATE_ON_START) await runMigrations(db.directPool, path.resolve(__dirname, '../migrations'), logger);
  await storage.ensureBucket();
  logger.info({ bucket: config.S3_BUCKET }, 'object storage ready');

  if (config.SEED_DEMO_DATA && config.NODE_ENV !== 'production') {
    await seedDemoData(pool, storage, logger, config.WEB_URL);
  }

  const app = await buildApp({
    config,
    pool,
    directPool: db.directPool,
    readPool: db.readPool,
    storage,
    multipartStorage: storage,
    logger,
  });
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });

  // Background work (email, notifications, purges, scheduled maintenance) runs in the worker
  // process (src/worker.ts), not here, so request handling never waits on it.
  logger.info({ port: config.API_PORT }, 'api listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    // Stops accepting connections and waits for in-flight requests to finish.
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
