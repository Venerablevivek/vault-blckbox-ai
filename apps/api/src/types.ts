import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from './config';
import type { FileStorage } from './storage/file-storage';

/** Injected so expiry logic can be tested by moving time rather than sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AppDeps {
  config: Config;
  pool: Pool;
  storage: FileStorage;
  logger: Logger;
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
    maintenance: import('./modules/maintenance/maintenance.service').MaintenanceService;
  }
  interface FastifyRequest {
    /** Set by the session plugin. Null when the request is unauthenticated. */
    user: SessionUser | null;
    /** Set by requireMember() for routes scoped to a workspace. */
    membership: Membership | null;
  }
}
