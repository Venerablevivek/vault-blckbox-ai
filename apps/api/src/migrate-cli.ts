import path from 'node:path';
import { loadConfig } from './config';
import { ensureAppRole } from './db/app-role';
import { createPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { buildLoggerOptions, pino } from './lib/logger';

/**
 * Applies migrations as the database owner, then makes sure the least-privilege application role
 * exists and has exactly its privileges. Run once per deploy, before the API and worker start:
 *   node dist/migrate-cli.js
 * The API and worker then connect as that role and never hold owner credentials.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(buildLoggerOptions(config.NODE_ENV)).child({ process: 'migrate' });
  const adminUrl = config.DATABASE_ADMIN_URL ?? config.DATABASE_DIRECT_URL ?? config.DATABASE_URL;
  const pool = createPool(adminUrl, { max: 2, applicationName: 'vault-migrate' });
  try {
    await runMigrations(pool, path.resolve(__dirname, '../migrations'), logger);
    if (config.APP_DB_PASSWORD) {
      const client = await pool.connect();
      try {
        await ensureAppRole(client, config.APP_DB_PASSWORD);
      } finally {
        client.release();
      }
      logger.info('application role vault_app is ready');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
