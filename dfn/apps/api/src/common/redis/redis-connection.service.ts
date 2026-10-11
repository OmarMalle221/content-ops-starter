import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import { ENV, type Env } from '../../config/env';

/** Prefix of every key the API itself writes in Redis (BullMQ keeps its own "bull:" prefix). */
export const REDIS_KEY_PREFIX = 'dfn:';

/** Anything that can hand out a ready-to-use ioredis client (the service below, or a test double). */
export interface RedisClientSource {
  client(): Redis;
}

/** Shutdown never waits more than this for a QUIT reply before dropping the socket. */
const QUIT_TIMEOUT_MS = 2_000;
/** Connection errors are logged at most once per interval per connection (no log storms). */
const ERROR_LOG_INTERVAL_MS = 30_000;

/** `redis://host:port/db` without credentials, for logs. */
export function describeRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '6379'}${parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/0'}`;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Owns every Redis connection the API opens. Nothing connects until a feature asks for a client
 * (RATE_LIMIT_STORE=redis, JOBS_DRIVER=bullmq): with the defaults (memory / inprocess) the API
 * never touches Redis. All connections are closed on application shutdown, after the modules
 * that use them (BullMQ workers, throttler) have been destroyed — `app.close()` leaves no handle.
 */
@Injectable()
export class RedisConnectionService implements OnApplicationShutdown, RedisClientSource {
  private readonly logger = new Logger('Redis');
  private shared?: Redis;
  private readonly dedicated = new Set<Redis>();
  private closed = false;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** True when REDIS_URL is set. */
  get configured(): boolean {
    return Boolean(this.env.REDIS_URL);
  }

  /**
   * Shared command connection (rate limits, throttler, one-shot claims). Commands fail fast
   * (bounded retries and command timeout) so that callers can degrade instead of hanging.
   */
  client(): Redis {
    if (!this.shared) {
      this.shared = this.open('shared', {
        maxRetriesPerRequest: 1,
        commandTimeout: 1_500,
        connectTimeout: 3_000,
      });
    }
    return this.shared;
  }

  /**
   * A dedicated connection (e.g. BullMQ, which requires `maxRetriesPerRequest: null` and
   * duplicates it for its blocking commands). Closed with the others on shutdown.
   */
  createConnection(name: string, options: RedisOptions = {}): Redis {
    const connection = this.open(name, options);
    this.dedicated.add(connection);
    return connection;
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    const all = [...this.dedicated, ...(this.shared ? [this.shared] : [])];
    this.dedicated.clear();
    this.shared = undefined;
    await Promise.all(all.map((connection) => closeConnection(connection)));
  }

  private open(name: string, options: RedisOptions): Redis {
    if (this.closed) throw new Error('Redis connections are closed (application shutting down)');
    const url = this.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is required when JOBS_DRIVER=bullmq or RATE_LIMIT_STORE=redis');
    }
    const connection = new Redis(url, {
      // CLIENT SETNAME refuses spaces and special characters.
      connectionName: `dfn-api:${this.env.INSTANCE_ID}:${name}`.replace(/[^\w.:-]/g, '_').slice(0, 120),
      ...options,
    });
    let lastErrorLog = 0;
    connection.on('error', (err: Error) => {
      const now = Date.now();
      if (now - lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
      lastErrorLog = now;
      this.logger.warn(`redis ${name} (${describeRedisUrl(url)}): ${err.message}`);
    });
    return connection;
  }
}

/** QUIT when connected (pending replies are flushed), otherwise drop the socket right away. */
export async function closeConnection(connection: Redis): Promise<void> {
  if (connection.status === 'end') return;
  if (connection.status !== 'ready') {
    connection.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      connection.quit(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('quit timeout')), QUIT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    connection.disconnect();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
