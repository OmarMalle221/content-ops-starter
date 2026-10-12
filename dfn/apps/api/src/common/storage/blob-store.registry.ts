import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { StorageDriver } from '@dfn/shared';
import { ENV, type Env } from '../../config/env';
import { MAX_UPLOAD_HARD_MB, StorageError, maxSealedBytes, type BlobStore } from './blob-store';
import { LocalBlobStore } from './local-blob-store';
import { S3BlobStore } from './s3-blob-store';

/** Builds the blob store of one driver from the environment (no network call). */
export function createBlobStore(env: Env, driver: string = env.STORAGE_DRIVER): BlobStore {
  if (driver === StorageDriver.LOCAL)
    return new LocalBlobStore(env.STORAGE_DIR, maxSealedBytes(MAX_UPLOAD_HARD_MB));
  if (driver === StorageDriver.S3) return S3BlobStore.fromEnv(env);
  throw new StorageError('resolve', 'MISCONFIGURED');
}

/**
 * Resolves blob stores by driver. New blobs always go to the ACTIVE driver (STORAGE_DRIVER);
 * existing blobs are read from the driver recorded with them (Document.storageDriver), so that
 * switching STORAGE_DRIVER from local to s3 keeps older documents downloadable while they are
 * copied over. Stores are created lazily and cached; an s3 store without S3_BUCKET is refused.
 */
@Injectable()
export class BlobStoreRegistry implements OnModuleDestroy {
  private readonly stores = new Map<string, BlobStore>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  get activeDriver(): StorageDriver {
    return this.env.STORAGE_DRIVER;
  }

  /** Store new blobs are written to. */
  get active(): BlobStore {
    return this.forDriver(this.activeDriver);
  }

  /** Store holding blobs recorded with `driver` ("local" | "s3"); StorageError otherwise. */
  forDriver(driver: string): BlobStore {
    let store = this.stores.get(driver);
    if (!store) {
      store = createBlobStore(this.env, driver);
      this.stores.set(driver, store);
    }
    return store;
  }

  /** Test seam: replaces the store of a driver (e.g. an S3 store backed by a mocked client). */
  override(driver: StorageDriver, store: BlobStore): void {
    this.stores.set(driver, store);
  }

  onModuleDestroy() {
    for (const store of this.stores.values()) {
      if (store instanceof S3BlobStore) store.destroy();
    }
    this.stores.clear();
  }
}
