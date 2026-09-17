import path from 'node:path';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { buildLoggerOptions, pino } from './lib/logger';
import { createAuditService } from './modules/audit/audit.service';
import { createDocumentsService } from './modules/documents/documents.service';
import { createMaintenanceService } from './modules/maintenance/maintenance.service';
import { createNotificationsService } from './modules/notifications/notifications.service';
import { S3Storage } from './storage/s3-storage';
import { systemClock } from './types';

/**
 * Runs one cleanup pass and exits. The API also runs this on a timer; this entry point is for
 * running it on demand:  docker compose exec api node dist/maintenance.js
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(buildLoggerOptions(config.NODE_ENV));
  const pool = createPool(config.DATABASE_URL);
  await runMigrations(pool, path.resolve(__dirname, '../migrations'), logger);

  const storage = new S3Storage({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  });
  const clock = systemClock;
  const audit = createAuditService({ pool, clock, logger });
  const notifications = createNotificationsService({ pool, clock, logger });
  const documents = createDocumentsService({
    pool, storage, clock, logger, audit, notifications,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    signedUrlTtlSeconds: config.SIGNED_URL_TTL_SECONDS,
    trashRetentionDays: config.TRASH_RETENTION_DAYS,
  });

  const result = await createMaintenanceService({ pool, clock, logger, documents }).runOnce();
  console.log(JSON.stringify(result ?? { skipped: 'another instance is running maintenance' }));
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Maintenance failed:', error);
  process.exit(1);
});
