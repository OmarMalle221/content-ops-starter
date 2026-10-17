import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { MaintenanceRun } from '@dfn/database';
import { KeyPurpose, KeyRingAction, ManagedKeyAction, ManagedKeyStatus } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { LEGACY_KEY_ID, keyRingFor } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { RECOVERY_HASH_V2_PREFIX } from '../auth/recovery-codes.service';
import { MaintenanceService } from '../jobs/maintenance.service';
import { KeyLifecycleService, MANAGED_KEY_SELECT, type ManagedKeyRow } from './key-lifecycle.service';
import { KEY_PURPOSES, KEY_ROTATION_JOB, ROTATION_BATCH, rotationTrigger } from './key-rotation.service';
import { countsByKeyId, deletedBlobCountsByKeyId, type LegacyUsage } from './key-usage';
import { ManagedKeysService } from './managed-keys.service';
import { SEALED_COLUMNS } from './sealed-columns';

export interface KeyUsageDto {
  keyId: string;
  /** New values of the purpose are sealed with this key. */
  active: boolean;
  /** The key is in the running key ring (false = values sealed with it cannot be opened). */
  configured: boolean;
  /** The pre-key-ring DOCUMENT_ENCRYPTION_KEY. */
  legacy: boolean;
  count: number;
}

/** A KMS-managed data key (EncryptionKey row) — ids, dates and counts, never key material. */
export interface ManagedKeyDto {
  keyId: string;
  status: ManagedKeyStatus;
  kmsProvider: string;
  kmsKeyRef: string;
  createdAt: Date;
  /** null when the scheduled rotation created it. */
  createdByUserId: string | null;
  activateAfter: Date | null;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  retiredAt: Date | null;
  /** Unwrapped and installed in the key ring of the replica that answered. */
  loaded: boolean;
  /** Values (stored document blobs, deleted ones retained until the purge included) sealed with it. */
  count: number;
  /** Of which blobs of deleted, not yet purged documents (documents only). */
  deletedBlobs: number;
  /** Why RETIRE is not offered yet (DECRYPT_ONLY keys only). */
  retireBlocker: { reason: string; details: Record<string, unknown> } | null;
  nextActions: ManagedKeyAction[];
}

export interface PurposeStatusDto {
  purpose: KeyPurpose;
  sources: string[];
  activeKeyId: string;
  configuredKeyIds: string[];
  keys: KeyUsageDto[];
  total: number;
  pendingRotation: number;
  /** Values sealed with a key id missing from the ring. */
  unreadable: number;
  batchSize: number;
  /** KMS-managed keys of the purpose, newest first (RETIRED ones included, for the record). */
  managedKeys: ManagedKeyDto[];
  /** What still depends on the legacy key (DOCUMENT_ENCRYPTION_KEY). */
  legacy: LegacyUsage;
  nextActions: Array<KeyRingAction | ManagedKeyAction>;
}

export function runDto(run: MaintenanceRun) {
  return {
    id: run.id,
    jobName: run.jobName,
    status: run.status,
    triggeredBy: run.triggeredBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    summary: run.summary,
    error: run.error,
  };
}

/**
 * Key ring status (key ids per purpose and how many stored values each one seals, KMS-managed
 * keys and their lifecycle, legacy-key usage) and on-demand rotation. Key material never leaves
 * the ring: only key ids, statuses and counts are exposed.
 */
@Injectable()
export class KeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
    private readonly managed: ManagedKeysService,
    private readonly lifecycle: KeyLifecycleService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async managedKeyDto(
    row: ManagedKeyRow,
    counts: Map<string, number>,
    deleted: Map<string, number>,
  ): Promise<ManagedKeyDto> {
    const blocker =
      row.status === ManagedKeyStatus.DECRYPT_ONLY ? await this.lifecycle.retireBlocker(row) : null;
    return {
      keyId: row.keyId,
      status: row.status,
      kmsProvider: row.kmsProvider,
      kmsKeyRef: row.kmsKeyRef,
      createdAt: row.createdAt,
      createdByUserId: row.createdByUserId,
      activateAfter: row.activateAfter,
      activatedAt: row.activatedAt,
      deactivatedAt: row.deactivatedAt,
      retiredAt: row.retiredAt,
      loaded: this.managed.isLoaded(row.id),
      count: counts.get(row.keyId) ?? 0,
      deletedBlobs: row.purpose === KeyPurpose.DOCUMENTS ? (deleted.get(row.keyId) ?? 0) : 0,
      retireBlocker: blocker ? { reason: blocker.reason, details: blocker.details } : null,
      nextActions: row.status === ManagedKeyStatus.DECRYPT_ONLY && !blocker ? [ManagedKeyAction.RETIRE] : [],
    };
  }

  private async purposeStatus(
    purpose: KeyPurpose,
    rows: ManagedKeyRow[],
    deleted: Map<string, number>,
  ): Promise<PurposeStatusDto> {
    const ring = keyRingFor(this.env);
    const activeKeyId = ring.activeKeyId(purpose);
    const configuredKeyIds = ring.keyIds(purpose);
    const counts = await countsByKeyId(this.prisma, purpose);
    const observed = [...counts.keys()].filter((id) => !configuredKeyIds.includes(id)).sort();
    const keys = [...configuredKeyIds, ...observed].map((keyId) => ({
      keyId,
      active: keyId === activeKeyId,
      configured: ring.hasKey(purpose, keyId),
      legacy: keyId === LEGACY_KEY_ID,
      count: counts.get(keyId) ?? 0,
    }));
    const total = keys.reduce((n, k) => n + k.count, 0);
    const pendingRotation = keys.filter((k) => !k.active).reduce((n, k) => n + k.count, 0);
    const unreadable = keys.filter((k) => !k.configured).reduce((n, k) => n + k.count, 0);
    const managedKeys: ManagedKeyDto[] = [];
    for (const row of rows.filter((r) => r.purpose === purpose)) {
      managedKeys.push(await this.managedKeyDto(row, counts, deleted));
    }
    const nextActions: Array<KeyRingAction | ManagedKeyAction> =
      pendingRotation > 0 ? [KeyRingAction.ROTATE] : [];
    // One staged key at a time per purpose: GENERATE is offered again once it has been activated.
    if (this.managed.provider && !managedKeys.some((k) => k.status === ManagedKeyStatus.STAGED)) {
      nextActions.push(ManagedKeyAction.GENERATE);
    }
    return {
      purpose,
      sources:
        purpose === KeyPurpose.DOCUMENTS
          ? ['document.encryptionKeyId']
          : SEALED_COLUMNS.filter((c) => c.purpose === purpose).map((c) => c.source),
      activeKeyId,
      configuredKeyIds,
      keys,
      total,
      pendingRotation,
      unreadable,
      batchSize: ROTATION_BATCH[purpose],
      managedKeys,
      legacy: {
        values: counts.get(LEGACY_KEY_ID) ?? 0,
        deletedBlobs: purpose === KeyPurpose.DOCUMENTS ? (deleted.get(LEGACY_KEY_ID) ?? 0) : 0,
      },
      nextActions,
    };
  }

  async status() {
    // Report the keys recorded in the database, not a view up to KEYRING_REFRESH_SECONDS old (another
    // replica may have generated, activated or retired a key since); only new keys reach the KMS.
    await this.managed.refresh();
    const [rows, deleted] = await Promise.all([
      this.prisma.encryptionKey.findMany({ orderBy: { createdAt: 'desc' }, select: MANAGED_KEY_SELECT }),
      deletedBlobCountsByKeyId(this.prisma),
    ]);
    const purposes = [];
    for (const purpose of KEY_PURPOSES) purposes.push(await this.purposeStatus(purpose, rows, deleted));
    const [drivers, lastRun, sessionSecretBound] = await Promise.all([
      this.prisma.document.groupBy({
        by: ['storageDriver'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.maintenanceRun.findFirst({
        where: { jobName: KEY_ROTATION_JOB },
        orderBy: { startedAt: 'desc' },
      }),
      // Unused recovery codes whose hash is still keyed with SESSION_SECRET.
      this.prisma.mfaRecoveryCode.count({
        where: { usedAt: null, NOT: { codeHash: { startsWith: RECOVERY_HASH_V2_PREFIX } } },
      }),
    ]);
    const pendingRotation = purposes.reduce((n, p) => n + p.pendingRotation, 0);
    const ring = keyRingFor(this.env);
    const legacyValues = purposes.reduce((n, p) => n + p.legacy.values, 0);
    const legacyDeletedBlobs = purposes.reduce((n, p) => n + p.legacy.deletedBlobs, 0);
    const kms = this.managed.state;
    return {
      sandbox: true,
      storage: {
        activeDriver: this.env.STORAGE_DRIVER,
        documentsByDriver: drivers
          .map((d) => ({ driver: d.storageDriver, count: d._count._all }))
          .sort((a, b) => a.driver.localeCompare(b.driver)),
      },
      scheduler: { enabled: this.env.JOBS_ENABLED, intervalMinutes: this.env.JOBS_INTERVAL_MINUTES },
      purposes,
      totals: {
        values: purposes.reduce((n, p) => n + p.total, 0),
        pendingRotation,
        unreadable: purposes.reduce((n, p) => n + p.unreadable, 0),
      },
      lastRun: lastRun ? runDto(lastRun) : null,
      kms: {
        provider: this.env.KMS_PROVIDER,
        keyRef: this.managed.provider?.keyRef ?? null,
        activationDelaySeconds: this.env.KEY_ACTIVATION_DELAY_SECONDS,
        refreshSeconds: this.env.KEYRING_REFRESH_SECONDS,
        rotationIntervalDays: this.env.KEY_ROTATION_INTERVAL_DAYS,
        lastRefreshAt: kms.lastRefreshAt,
        refreshError: kms.error,
        loadFailures: kms.failures,
      },
      legacy: {
        decryptEnabled: ring.legacyDecrypt,
        values: legacyValues,
        deletedBlobs: legacyDeletedBlobs,
        /** ENCRYPTION_LEGACY_DECRYPT=false is safe: nothing uses the legacy key, every purpose seals with another. */
        safeToDisable: legacyValues === 0 && KEY_PURPOSES.every((p) => ring.activeKeyId(p) !== LEGACY_KEY_ID),
      },
      recoveryCodes: {
        secret: this.env.MFA_RECOVERY_SECRET ? 'MFA_RECOVERY_SECRET' : 'SESSION_SECRET',
        sessionSecretBound,
      },
      nextActions: pendingRotation > 0 ? [KeyRingAction.ROTATE] : [],
    };
  }

  /**
   * Runs ENCRYPTION_KEY_ROTATION now through the jobs runner (same lock and history as the
   * scheduler and the jobs console). A run already in progress answers 409 JOB_ALREADY_RUNNING.
   */
  async rotateNow(auth: AuthContext, purpose: KeyPurpose | undefined, req: Request) {
    const run = await this.maintenance.run(KEY_ROTATION_JOB, rotationTrigger(auth.userId, purpose));
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.keys_rotate',
      entityType: 'MaintenanceRun',
      entityId: run.id,
      metadata: { purpose: purpose ?? 'all', status: run.status, error: run.error ?? undefined },
      ...requestMeta(req),
    });
    return runDto(run);
  }
}
