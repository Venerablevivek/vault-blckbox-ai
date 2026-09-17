import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from './config';
import type { JobHandlers } from './jobs/queue';
import type { Mailer } from './mail/mailer';
import type { MaintenanceService } from './modules/maintenance/maintenance.service';
import type { Services } from './services';
import type { FileStorage } from './storage/file-storage';
import type { MultipartStorage } from './storage/multipart-storage';

/** Injected so expiry logic can be tested by moving time rather than sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AppDeps {
  config: Config;
  pool: Pool;
  storage: FileStorage;
  /** Enables direct uploads. main.ts passes the S3 store; tests can swap `storage` independently. */
  multipartStorage?: FileStorage & MultipartStorage;
  logger: Logger;
  /** Defaults to SMTP when SMTP_URL is set, otherwise a logging fallback. */
  mailer?: Mailer;
  clock?: Clock;
}

export type Role = 'OWNER' | 'MEMBER' | 'VIEWER';

export interface SessionUser {
  id: string;
  email: string;
}

export interface Membership {
  workspaceId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Housekeeping jobs. Scheduled by main.ts; tests call runOnce() directly. */
    maintenance: MaintenanceService;
    services: Services;
    jobHandlers: JobHandlers;
    /** Method and URL of every registered route (HEAD excluded). */
    routeTable: ReadonlyArray<{ method: string; url: string }>;
  }
  interface FastifyRequest {
    /** Set by the session plugin. Null when the request is unauthenticated. */
    user: SessionUser | null;
    /** The id of the session row behind `user`, so "this device" can be told apart. */
    sessionId: string | null;
    /** Set by requireMember() for routes scoped to a workspace. */
    membership: Membership | null;
  }
}
