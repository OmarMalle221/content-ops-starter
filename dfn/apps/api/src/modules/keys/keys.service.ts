import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { MaintenanceRun } from '@dfn/database';
import { KeyPurpose, KeyRingAction } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { LEGACY_KEY_ID, keyRingFor } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { MaintenanceService } from '../jobs/maintenance.service';
import { KEY_PURPOSES, KEY_ROTATION_JOB, ROTATION_BATCH, rotationTrigger } from './key-rotation.service';
import { SEALED_COLUMNS, countByKeyId } from './sealed-columns';

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
  nextActions: KeyRingAction[];
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
 * Key ring status (key ids per purpose and how many stored values each one seals) and on-demand
 * rotation. Key material never leaves the ring: only key ids and counts are exposed.
 */
@Injectable()
export class KeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async countsFor(purpose: KeyPurpose): Promise<Map<string, number>> {
    if (purpose === KeyPurpose.DOCUMENTS) {
      const groups = await this.prisma.document.groupBy({
        by: ['encryptionKeyId'],
        where: { deletedAt: null, encrypted: true },
        _count: { _all: true },
      });
      return new Map(groups.map((g) => [g.encryptionKeyId ?? LEGACY_KEY_ID, g._count._all]));
    }
    const spec = SEALED_COLUMNS.find((c) => c.purpose === purpose)!;
    return countByKeyId(this.prisma, spec);
  }

  private async purposeStatus(purpose: KeyPurpose): Promise<PurposeStatusDto> {
    const ring = keyRingFor(this.env);
    const activeKeyId = ring.activeKeyId(purpose);
    const configuredKeyIds = ring.keyIds(purpose);
    const counts = await this.countsFor(purpose);
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
      nextActions: pendingRotation > 0 ? [KeyRingAction.ROTATE] : [],
    };
  }

  async status() {
    const purposes = [];
    for (const purpose of KEY_PURPOSES) purposes.push(await this.purposeStatus(purpose));
    const [drivers, lastRun] = await Promise.all([
      this.prisma.document.groupBy({
        by: ['storageDriver'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.maintenanceRun.findFirst({
        where: { jobName: KEY_ROTATION_JOB },
        orderBy: { startedAt: 'desc' },
      }),
    ]);
    const pendingRotation = purposes.reduce((n, p) => n + p.pendingRotation, 0);
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
