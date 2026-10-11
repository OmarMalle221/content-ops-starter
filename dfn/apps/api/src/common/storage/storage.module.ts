import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import type { StorageHealth } from './blob-store';
import { BlobStoreRegistry } from './blob-store.registry';

/** Injection token of the active BlobStore (the driver selected by STORAGE_DRIVER). */
export const BLOB_STORE = 'BLOB_STORE';

/**
 * Probes the active store once the application has started and logs the outcome. The log line
 * names the driver and location (directory, or bucket @ endpoint host) — never credentials. A
 * failing probe does not stop the API: document routes answer 503 STORAGE_UNAVAILABLE until the
 * backend recovers, and everything else keeps working.
 */
@Injectable()
export class StorageHealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Storage');
  private last: StorageHealth | null = null;

  constructor(
    private readonly registry: BlobStoreRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    await this.check();
  }

  /** Runs the health check of the active store (never throws). */
  async check(): Promise<StorageHealth> {
    let health: StorageHealth;
    try {
      health = await this.registry.active.healthCheck();
    } catch (err) {
      // Only reachable when the store cannot even be built (e.g. s3 without a bucket).
      health = {
        driver: this.registry.activeDriver,
        ok: false,
        latencyMs: 0,
        location: 'unconfigured',
        reason: (err as { reason?: StorageHealth['reason'] }).reason ?? 'MISCONFIGURED',
      };
    }
    this.last = health;
    if (health.ok) {
      this.logger.log(
        `storage driver=${health.driver} location=${health.location} ok (${health.latencyMs} ms)`,
      );
    } else {
      this.logger.error(
        `storage driver=${health.driver} location=${health.location} UNAVAILABLE (${health.reason ?? 'unknown'})`,
      );
    }
    return health;
  }

  get lastHealth(): StorageHealth | null {
    return this.last;
  }
}

/**
 * Encrypted object storage (local filesystem or S3-compatible). Global so that any feature module
 * (and the health endpoint) can resolve the stores; it is imported by DocumentsModule.
 */
@Global()
@Module({
  providers: [
    BlobStoreRegistry,
    StorageHealthService,
    {
      provide: BLOB_STORE,
      useFactory: (registry: BlobStoreRegistry) => registry.active,
      inject: [BlobStoreRegistry],
    },
  ],
  exports: [BlobStoreRegistry, StorageHealthService, BLOB_STORE],
})
export class StorageModule {}
