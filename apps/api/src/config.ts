import { z } from 'zod';

/**
 * Environment is parsed exactly once, here, at boot. If anything is missing or
 * malformed the process exits immediately with a readable message rather than
 * failing later inside a request handler.
 *
 * `process.env` is not read anywhere else in the codebase.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Addresses allowed to set X-Forwarded-For. Only a request whose socket address is in
   * this list has its forwarded client IP believed; everyone else is identified by their
   * own socket address. Trusting every sender (`trustProxy: true`) let any client pick
   * its own IP, which defeated per-IP rate limiting and faked share-link viewer counts.
   *
   * In Compose this is the web container's fixed address. Loopback is the default so a
   * locally run web server can still pass the browser's address through.
   */
  TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.1,::1')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  API_PORT: z.coerce.number().int().positive().default(4000),

  /**
   * Per-client rate limits. Off by default only under NODE_ENV=test, where every request comes from
   * one address; tests of the limiter turn it on explicitly.
   */
  RATE_LIMIT_ENABLED: booleanish.optional(),
  /** postgres: counters shared by every API instance. memory: per process, for a single instance. */
  RATE_LIMIT_STORE: z.enum(['postgres', 'memory']).default('postgres'),
  WEB_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  /**
   * A direct (not transaction-pooled) connection, for LISTEN, advisory locks, migrations and
   * maintenance. Set it when DATABASE_URL points at PgBouncer in transaction mode.
   */
  DATABASE_DIRECT_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  /** A read replica for lag-tolerant reads (dashboard, audit trail). Defaults to DATABASE_URL. */
  DATABASE_READ_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /**
   * The database owner, used only by the migrate command (dist/migrate-cli.js). The API and worker
   * connect as the least-privilege vault_app role and never need this.
   */
  DATABASE_ADMIN_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  /** Password the migrate command sets on the vault_app role. Unset: the role isn't managed. */
  APP_DB_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(12).optional()),
  /**
   * Apply migrations when the API or worker starts. Convenient for `npm run dev` with one database
   * user; Compose turns it off and runs the migrate service instead.
   */
  MIGRATE_ON_START: booleanish.default(true),
  /** Per-statement limit for request queries, in milliseconds. 0 disables it. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),

  SESSION_COOKIE_NAME: z.string().min(1).default('fs_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  SESSION_COOKIE_SECURE: booleanish.default(false),

  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400), // 25 MB
  SHARE_DEFAULT_TTL_HOURS: z.coerce.number().int().positive().default(168),
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(168),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  // Keys the hash used for share-link viewer counting. Changing it resets distinct-viewer
  // counts, which is the correct behaviour: the old hashes become meaningless.
  IP_HASH_PEPPER: z.string().min(8).default('dev-only-pepper-change-me'),

  /**
   * Signs the short-lived cookie that unlocks a password-protected share link in one browser.
   * Changing it invalidates every outstanding unlock. Use a long random value in production.
   */
  SHARE_GRANT_SECRET: z.string().min(16).default('dev-only-share-grant-secret-change-me'),

  /** Uploads buffered in memory at once; worst-case memory is this x MAX_UPLOAD_BYTES. */
  MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(64).default(4),

  /**
   * Largest file accepted through direct (browser-to-storage) uploads. Bytes never pass through
   * the API, so this is bounded by storage and quota, not API memory. 5 GB by default.
   */
  MAX_DIRECT_UPLOAD_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  /** How long an upload session may stay open before it is aborted and its quota released. */
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Lifetime of each signed part-upload URL. */
  UPLOAD_PART_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),

  /** Zip downloads: most files and total bytes in one archive, and archives streaming at once. */
  ARCHIVE_MAX_FILES: z.coerce.number().int().min(1).max(10_000).default(1000),
  ARCHIVE_MAX_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  MAX_CONCURRENT_ARCHIVES: z.coerce.number().int().min(1).max(64).default(4),

  /** Largest PDF a view-only link will show; each one is held in memory while it is watermarked. */
  SHARE_WATERMARK_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),

  /** Earlier versions kept per document; the oldest go when a new version would exceed this. */
  DOCUMENT_MAX_VERSIONS: z.coerce.number().int().min(1).max(500).default(20),

  /**
   * Allow webhook URLs over plain http and to private or local addresses. Only for development
   * and tests: in production a webhook must never reach the internal network.
   */
  WEBHOOK_ALLOW_INSECURE: booleanish.default(false),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),

  /** Days a deleted document stays restorable before it is purged. */
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Failed logins for one email address, inside the window, before the address is locked. */
  LOGIN_LOCKOUT_ATTEMPTS: z.coerce.number().int().min(3).max(100).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /** How often the in-process cleanup job runs. 0 disables it (tests call it directly). */
  MAINTENANCE_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),

  /**
   * SMTP server for transactional email, e.g. smtp://mailpit:1025 in Compose. When unset,
   * emails are not sent and the API logs the recipient and subject instead.
   */
  SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  MAIL_FROM: z.string().min(3).default('Vault <no-reply@vault.local>'),

  /**
   * Months of share-link access history kept. Whole monthly partitions older than this are
   * dropped; counters on the links (opens, viewers, downloads) are unaffected.
   */
  SHARE_EVENT_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(13),

  /** Seconds between keep-alive comments on notification streams (below proxy idle timeouts). */
  NOTIFICATION_STREAM_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),

  /**
   * required: new accounts confirm their address by email before they can create share links or
   * invite people. off: accounts are treated as verified (for deployments without email).
   */
  EMAIL_VERIFICATION: z.enum(['required', 'off']).default('required'),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(48),

  /**
   * clamav: every upload is scanned by clamd before it can be downloaded or shared. off: uploads are
   * marked 'unscanned' and allowed. Production deployments should scan.
   */
  SCAN_MODE: z.enum(['off', 'clamav']).default('off'),
  CLAMAV_HOST: z.string().min(1).default('clamav'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  /** Larger files are marked 'unscanned' instead of scanned. Must not exceed clamd's StreamMaxLength. */
  SCAN_MAX_BYTES: z.coerce.number().int().positive().default(104_857_600),
  SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** Largest file the worker reads for a thumbnail and search text (each is held in memory). */
  PROCESSING_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
  /**
   * gotenberg: Office files are converted to PDF (by LibreOffice, in the Gotenberg container) so
   * they can be previewed, get a thumbnail, and legacy .doc/.xls/.ppt become searchable.
   */
  OFFICE_PREVIEWS: z.enum(['off', 'gotenberg']).default('off'),
  GOTENBERG_URL: z.string().url().default('http://gotenberg:3000'),
  OFFICE_CONVERSION_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /** How long a password reset link works. */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

  EXPOSE_INVITE_LINKS: booleanish.default(true),
  SEED_DEMO_DATA: booleanish.default(false),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
