// Tracing first, so the libraries below are instrumented as they load.
import './observability/tracing';
import path from 'node:path';
import { loadConfig } from './config';
import { createDatabase } from './db/pool';
import { runMigrations } from './db/migrate';
import { createJobHandlers } from './jobs/handlers';
import { buildLoggerOptions, pino } from './lib/logger';
import { LogMailer, SmtpMailer } from './mail/mailer';
import { createServices } from './services';
import { S3Storage } from './storage/s3-storage';
import { systemClock } from './types';
import { startMetricsServer, watchPools, watchQueue } from './observability/metrics';

/**
 * The background worker: sends email, fans out notifications, computes checksums, purges
 * deleted workspaces, and schedules the maintenance pass. Run as its own process
 * (`node dist/worker.js`) so request handling never waits on this work, and scaled
 * independently: any number of workers can run, because jobs are claimed with SKIP LOCKED.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(buildLoggerOptions(config.NODE_ENV)).child({ process: 'worker' });
  const db = createDatabase(config, 'vault-worker');
  const { pool } = db;
  if (config.MIGRATE_ON_START) await runMigrations(db.directPool, path.resolve(__dirname, '../migrations'), logger);

  const storage = S3Storage.fromConfig(config);
  const mailer = config.SMTP_URL ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) : new LogMailer(logger);
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
  const stopJobs = services.jobs.start(createJobHandlers(services, mailer));

  // Maintenance runs once per interval across all workers: the dedupe key is the interval
  // slot and `once` skips a slot that already has a job, running or finished. (Without `once`
  // a finished slot freed its key, and maintenance ran every minute.)
  const stopSchedule = scheduleEvery(60_000, async () => {
    const minutes = config.MAINTENANCE_INTERVAL_MINUTES;
    if (minutes <= 0) return;
    const bucket = Math.floor(Date.now() / (minutes * 60_000));
    await services.jobs.enqueue(
      pool,
      'maintenance.run',
      {},
      { dedupeKey: `every-${minutes}m:${bucket}`, once: true, maxAttempts: 1 },
    );
  });

  logger.info('worker started');
  watchPools({ main: pool, direct: db.directPool });
  watchQueue(pool);
  if (config.METRICS_PORT > 0) startMetricsServer(config.METRICS_PORT, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down; finishing the current job');
    stopSchedule();
    await stopJobs();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function scheduleEvery(ms: number, task: () => Promise<void>): () => void {
  const run = () => void task().catch(() => undefined);
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, ms);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

main().catch((error: unknown) => {
  console.error('Fatal worker error:', error);
  process.exit(1);
});
