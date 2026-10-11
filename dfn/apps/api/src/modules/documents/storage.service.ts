import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decryptBuffer, encryptBuffer } from '../../common/crypto';
import { ENV, type Env } from '../../config/env';

/**
 * Local encrypted blob storage (AES-256-GCM). The interface is intentionally minimal so an
 * S3-compatible adapter can replace it without touching the documents module.
 */
@Injectable()
export class StorageService {
  private readonly root: string;
  constructor(@Inject(ENV) private readonly env: Env) {
    this.root = resolve(env.STORAGE_DIR);
  }

  private pathFor(key: string) {
    const safe = key.replace(/[^a-zA-Z0-9/_-]/g, '');
    const full = resolve(join(this.root, safe));
    if (!full.startsWith(this.root)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, plaintext: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, encryptBuffer(this.env.DOCUMENT_ENCRYPTION_KEY, plaintext), { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return decryptBuffer(this.env.DOCUMENT_ENCRYPTION_KEY, await readFile(this.pathFor(key)));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => undefined);
  }
}
