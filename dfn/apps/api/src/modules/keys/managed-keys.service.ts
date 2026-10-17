import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KeyPurpose, ManagedKeyStatus } from '@dfn/shared';
import { createKmsProvider, kmsFailureReason, kmsUnavailable, type KmsProvider } from '../../common/kms';
import {
  LEGACY_KEY_ID,
  isManagedKeyId,
  keyRingFor,
  type KeyRing,
  type ManagedKeyMaterial,
} from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { legacyUsage } from './key-usage';

const PURPOSES = new Set<string>(Object.values(KeyPurpose));

/**
 * The environment's key ring, built eagerly so that a malformed ENCRYPTION_KEYRING fails the boot
 * instead of the first seal/open. The key ring error may quote part of the faulty entry: hex runs
 * are redacted before it is rethrown.
 */
export function validatedKeyRing(env: Env): KeyRing {
  try {
    return keyRingFor(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ENCRYPTION_KEYRING is invalid: ${message.replace(/[0-9a-f]{8,}/gi, '[redacted]')}`);
  }
}

interface CachedKey {
  purpose: KeyPurpose;
  keyId: string;
  key: Buffer;
}

/** A managed key this replica could not load (reason only — never KMS messages). */
export interface ManagedKeyLoadFailure {
  purpose: string;
  keyId: string;
  status: string;
  reason: string;
}

export interface ManagedKeysState {
  lastRefreshAt: Date | null;
  /** Keys of the last refresh that could not be unwrapped (empty when everything loaded). */
  failures: ManagedKeyLoadFailure[];
  /** Managed keys installed in the ring by the last refresh. */
  loaded: number;
  /** Set when the last refresh failed as a whole (database error): the ring kept its keys. */
  error: string | null;
}

/**
 * Loads the KMS-managed data keys (EncryptionKey rows) into this replica's key ring, at boot and
 * every KEYRING_REFRESH_SECONDS (ADR-0014).
 *
 * - Every non-RETIRED row is installed: ACTIVE seals, STAGED and DECRYPT_ONLY only open. A key is
 *   unwrapped by the KMS once and cached in memory (refreshes only unwrap new rows), so a KMS outage
 *   after boot does not take keys away from a running replica; RETIRED keys are dropped and their
 *   buffers zeroed. If an ACTIVE key cannot be unwrapped here, this replica seals with the purpose's
 *   environment key (or the legacy key) — readable by every replica — until it can.
 * - Boot fails fast when a non-retired managed key cannot be unwrapped (KMS down, wrong master key,
 *   KMS_PROVIDER=none while managed keys exist): serving with missing keys would turn reads of the
 *   values they sealed into errors. Later refresh failures keep the keys already loaded and are
 *   logged as errors (alert on them) and reported by GET /v1/admin/keys.
 * - Unwrapped keys are never logged, returned or serialised: only ids, statuses and reasons are.
 */
@Injectable()
export class ManagedKeysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedKeysService.name);
  readonly provider: KmsProvider | null;
  private readonly cache = new Map<string, CachedKey>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private current: ManagedKeysState = { lastRefreshAt: null, failures: [], loaded: 0, error: null };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.provider = createKmsProvider(env);
  }

  private get ring(): KeyRing {
    return keyRingFor(this.env);
  }

  get state(): ManagedKeysState {
    return { ...this.current, failures: [...this.current.failures] };
  }

  /** True when the row's data key is unwrapped in this replica. */
  isLoaded(rowId: string): boolean {
    return this.cache.has(rowId);
  }

  /**
   * Key id of the purpose's ACTIVE managed key when this replica could not load it at the last
   * refresh (it then seals with the environment or legacy key), otherwise null.
   */
  unloadedActiveKeyId(purpose: KeyPurpose): string | null {
    const failure = this.current.failures.find(
      (f) => f.purpose === purpose && f.status === ManagedKeyStatus.ACTIVE,
    );
    return failure?.keyId ?? null;
  }

  async onModuleInit(): Promise<void> {
    validatedKeyRing(this.env);
    await this.refresh({ strict: true });
    if (this.provider) {
      this.logger.log(
        `KMS provider=${this.provider.name} keyRef=${this.provider.keyRef}: ${this.current.loaded} managed key(s) loaded`,
      );
      if (this.env.KEY_ACTIVATION_DELAY_SECONDS < this.env.KEYRING_REFRESH_SECONDS) {
        this.logger.warn(
          `KEY_ACTIVATION_DELAY_SECONDS (${this.env.KEY_ACTIVATION_DELAY_SECONDS}) < KEYRING_REFRESH_SECONDS ` +
            `(${this.env.KEYRING_REFRESH_SECONDS}): with several replicas, a new key may seal values before ` +
            'every replica has loaded it',
        );
      }
    }
    await this.checkLegacyRetirement();
    // Tests drive refresh() explicitly; every other environment refreshes on a timer.
    if (this.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => {
        void this.refresh().catch((err: unknown) => {
          this.logger.error(`managed keys refresh failed: ${err instanceof Error ? err.name : 'error'}`);
        });
      }, this.env.KEYRING_REFRESH_SECONDS * 1000);
      this.timer.unref();
    }
  }

  /**
   * Stops the refresh timer. The ring keeps its keys: requests still in flight during a graceful
   * shutdown must keep sealing and opening with the same keys.
   */
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Reloads the managed keys from the database into the ring. Calls are serialised (each one
   * reflects the rows committed before it started). `strict` (boot) throws when a non-retired key
   * cannot be loaded; otherwise failures are logged and reported, and the ring keeps what loaded.
   */
  refresh(options: { strict?: boolean } = {}): Promise<ManagedKeysState> {
    const run = this.chain.then(() => this.load(Boolean(options.strict)));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(strict: boolean): Promise<ManagedKeysState> {
    let rows;
    try {
      rows = await this.prisma.encryptionKey.findMany({
        where: { status: { not: ManagedKeyStatus.RETIRED } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          purpose: true,
          keyId: true,
          status: true,
          wrappedKey: true,
          kmsProvider: true,
          kmsKeyRef: true,
        },
      });
    } catch (err) {
      if (strict) throw err;
      this.current = { ...this.current, error: 'DATABASE_UNAVAILABLE' };
      this.logger.error('managed keys refresh failed (database unavailable): keeping the loaded keys');
      return this.state;
    }

    const failures: ManagedKeyLoadFailure[] = [];
    const material: ManagedKeyMaterial[] = [];
    for (const row of rows) {
      if (!PURPOSES.has(row.purpose)) {
        failures.push({
          purpose: row.purpose,
          keyId: row.keyId,
          status: row.status,
          reason: 'UNKNOWN_PURPOSE',
        });
        continue;
      }
      if (!isManagedKeyId(row.keyId)) {
        failures.push({
          purpose: row.purpose,
          keyId: row.keyId,
          status: row.status,
          reason: 'INVALID_KEY_ID',
        });
        continue;
      }
      const purpose = row.purpose as KeyPurpose;
      if (!this.provider) {
        failures.push({ purpose, keyId: row.keyId, status: row.status, reason: 'KMS_NOT_CONFIGURED' });
        continue;
      }
      let cached = this.cache.get(row.id);
      if (!cached) {
        try {
          cached = { purpose, keyId: row.keyId, key: await this.unwrap(this.provider, row) };
          this.cache.set(row.id, cached);
        } catch (err) {
          failures.push({ purpose, keyId: row.keyId, status: row.status, reason: kmsFailureReason(err) });
          continue;
        }
      }
      material.push({
        purpose,
        keyId: row.keyId,
        key: cached.key,
        active: row.status === ManagedKeyStatus.ACTIVE,
      });
    }

    if (strict && failures.length > 0) {
      const list = failures.map((f) => `${f.purpose}:${f.keyId} (${f.status}, ${f.reason})`).join(', ');
      throw new Error(
        `KMS: ${failures.length} managed data key(s) cannot be loaded — refusing to start: ${list}. ` +
          'Check KMS_PROVIDER and its settings, the KMS availability and permissions (docs/operations/KEY_ROTATION.md).',
      );
    }

    try {
      this.ring.setManagedKeys(material);
    } catch (err) {
      // Only an inconsistent table gets here (the database constraints prevent it): keep the keys.
      if (strict) throw err;
      this.current = { ...this.current, error: 'INCONSISTENT_KEYS' };
      this.logger.error(`managed keys refresh refused: ${err instanceof Error ? err.message : 'error'}`);
      return this.state;
    }
    const live = new Set(rows.map((r) => r.id));
    for (const [id, entry] of this.cache) {
      if (live.has(id)) continue;
      this.cache.delete(id);
      entry.key.fill(0);
    }
    this.current = { lastRefreshAt: new Date(), failures, loaded: material.length, error: null };
    if (failures.length > 0) {
      this.logger.error(
        `managed keys refresh: ${failures.length} key(s) could not be loaded (${failures
          .map((f) => `${f.purpose}:${f.keyId} ${f.reason}`)
          .join(', ')}); the keys already loaded stay in use`,
      );
    }
    return this.state;
  }

  /** Unwraps a row's data key; a key wrapped by another provider is refused before any KMS call. */
  private unwrap(
    provider: KmsProvider,
    row: { purpose: string; keyId: string; wrappedKey: Uint8Array; kmsProvider: string; kmsKeyRef: string },
  ): Promise<Buffer> {
    if (row.kmsProvider !== provider.name) {
      return Promise.reject(kmsUnavailable(provider.name, 'unwrap', 'MASTER_KEY_MISMATCH'));
    }
    return provider.unwrap(
      Buffer.from(row.wrappedKey),
      { purpose: row.purpose, keyId: row.keyId },
      row.kmsKeyRef,
    );
  }

  /**
   * ENCRYPTION_LEGACY_DECRYPT=false: warns (never crashes) when values still need the legacy key —
   * they are unreadable until it is re-enabled — and when a purpose has no active key to seal with.
   */
  private async checkLegacyRetirement(): Promise<void> {
    if (this.env.ENCRYPTION_LEGACY_DECRYPT) return;
    const usage = await legacyUsage(this.prisma);
    const remaining = Object.entries(usage).filter(([, u]) => u.values > 0);
    if (remaining.length > 0) {
      this.logger.warn(
        `ENCRYPTION_LEGACY_DECRYPT=false but legacy-sealed values remain (${remaining
          .map(
            ([purpose, u]) =>
              `${purpose}: ${u.values}${u.deletedBlobs ? `, ${u.deletedBlobs} of deleted documents` : ''}`,
          )
          .join('; ')}): they cannot be opened until legacy decryption is re-enabled and they are rotated`,
      );
    }
    const unsealable = Object.values(KeyPurpose).filter((p) => this.ring.activeKeyId(p) === LEGACY_KEY_ID);
    if (unsealable.length > 0) {
      this.logger.warn(
        `ENCRYPTION_LEGACY_DECRYPT=false and no active key for: ${unsealable.join(', ')} — new values of ` +
          'these purposes cannot be sealed',
      );
    }
  }
}
