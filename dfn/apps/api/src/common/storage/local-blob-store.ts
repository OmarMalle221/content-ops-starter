import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { StorageDriver } from '@dfn/shared';
import {
  StorageError,
  assertValidStorageKey,
  type BlobMeta,
  type BlobStore,
  type StorageFailureReason,
  type StorageHealth,
  type StorageOperation,
} from './blob-store';

function reasonOf(err: unknown): StorageFailureReason {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'NOT_FOUND';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'ACCESS_DENIED';
  return 'IO_ERROR';
}

/**
 * Blobs on the local filesystem under STORAGE_DIR (development, tests, single-node sandbox).
 *
 *  - the on-disk path is `<root>/<key>` (the layout used since phase 2, so legacy blobs stay
 *    readable) and is re-checked to stay inside the root after resolution;
 *  - writes are atomic: the bytes go to a uniquely named sibling temp file (created exclusively,
 *    mode 0600), are fsync'ed, then renamed over the target — a crash leaves either the previous
 *    blob or the new one, never a truncated file;
 *  - reads refuse files larger than `maxBytes` before loading them in memory.
 */
export class LocalBlobStore implements BlobStore {
  readonly driver = StorageDriver.LOCAL;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly maxBytes: number,
  ) {
    this.root = resolve(rootDir);
  }

  /** Absolute path of a key — throws StorageError(INVALID_KEY) for anything not server-generated. */
  pathFor(key: string): string {
    assertValidStorageKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new StorageError('resolve', 'INVALID_KEY', this.driver);
    return full;
  }

  private fail(operation: StorageOperation, err: unknown): never {
    if (err instanceof StorageError) throw err;
    throw new StorageError(operation, reasonOf(err), this.driver);
  }

  async put(key: string, bytes: Buffer, _meta?: BlobMeta): Promise<void> {
    const path = this.pathFor(key);
    // Temp names contain dots, which keys never do: a temp file can never shadow a real key.
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      this.fail('put', err);
    }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new StorageError('get', 'NOT_FOUND', this.driver);
      if (info.size > this.maxBytes) throw new StorageError('get', 'TOO_LARGE', this.driver);
      return await readFile(path);
    } catch (err) {
      this.fail('get', err);
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.fail('delete', err);
    }
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      return (await stat(path)).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      this.fail('exists', err);
    }
  }

  async healthCheck(): Promise<StorageHealth> {
    const started = performance.now();
    const probe = `healthcheck/${randomBytes(8).toString('hex')}`;
    const payload = randomBytes(32);
    try {
      await this.put(probe, payload);
      const read = await this.get(probe);
      await this.delete(probe);
      const ok = read.equals(payload);
      return {
        driver: this.driver,
        ok,
        latencyMs: Math.round(performance.now() - started),
        location: this.root,
        ...(ok ? {} : { reason: 'CHECKSUM_MISMATCH' as const }),
      };
    } catch (err) {
      return {
        driver: this.driver,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        location: this.root,
        reason: err instanceof StorageError ? err.reason : reasonOf(err),
      };
    }
  }
}
