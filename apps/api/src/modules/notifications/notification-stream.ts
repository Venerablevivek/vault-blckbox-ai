import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

type Listener = () => void;

const CHANNEL = 'notifications';

/**
 * Fans PostgreSQL notifications out to open event streams in this process.
 *
 * One dedicated connection LISTENs for the whole process, opened when the first stream subscribes
 * and closed when the last one leaves. Delivery is best effort by design: a stream that misses a
 * signal (for example across a reconnect) still converges, because the client refetches its inbox
 * when a stream opens.
 */
export function createNotificationStreamHub(deps: { pool: Pool; logger: Logger }) {
  const { pool, logger } = deps;
  const listeners = new Map<string, Set<Listener>>();
  let client: PoolClient | null = null;
  let connecting: Promise<void> | null = null;
  let closed = false;

  async function connect(): Promise<void> {
    const connection = await pool.connect();
    connection.on('notification', (message) => {
      if (message.channel !== CHANNEL || !message.payload) return;
      for (const listener of listeners.get(message.payload) ?? []) listener();
    });
    connection.on('error', (error) => {
      logger.warn({ err: error }, 'notification listener connection lost; reconnecting');
      client = null;
      connection.release(true);
      if (!closed && listeners.size > 0) void ensureConnected();
    });
    await connection.query(`LISTEN ${CHANNEL}`);
    client = connection;
  }

  async function ensureConnected(): Promise<void> {
    if (client || closed) return;
    connecting ??= connect().finally(() => {
      connecting = null;
    });
    await connecting;
  }

  async function disconnectIfIdle(): Promise<void> {
    if (listeners.size > 0 || !client) return;
    const connection = client;
    client = null;
    await connection.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
    connection.release();
  }

  return {
    /** Calls `listener` whenever `userId` gets a notification. Returns an unsubscribe function. */
    async subscribe(userId: string, listener: Listener): Promise<() => void> {
      const set = listeners.get(userId) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(userId, set);
      await ensureConnected();
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(userId);
        void disconnectIfIdle();
      };
    },

    connectionsFor: (userId: string) => listeners.get(userId)?.size ?? 0,

    async close(): Promise<void> {
      closed = true;
      listeners.clear();
      // Take the connection first: a stream ending during shutdown may release it concurrently.
      const connection = client;
      client = null;
      if (connection) {
        await connection.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
        connection.release();
      }
    },
  };
}

export type NotificationStreamHub = ReturnType<typeof createNotificationStreamHub>;
