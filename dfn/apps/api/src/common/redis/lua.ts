import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

/** A Lua script run with EVALSHA, falling back to EVAL once when Redis has not cached it yet. */
export class LuaScript {
  readonly sha: string;

  constructor(readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run<T = unknown>(client: Redis, keys: string[], args: Array<string | number>): Promise<T> {
    try {
      return (await client.evalsha(this.sha, keys.length, ...keys, ...args)) as T;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
        return (await client.eval(this.source, keys.length, ...keys, ...args)) as T;
      }
      throw err;
    }
  }
}
