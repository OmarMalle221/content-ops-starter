import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { MaintenanceJobName } from '@dfn/database';
import type { AuthContext } from '../../common/auth-context';
import { AntivirusService } from '../../common/antivirus/antivirus.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { MaintenanceService, toRunDto } from '../jobs/maintenance.service';
import { purgeEligibleWhere } from './document-purge.service';
import {
  PENDING_MIGRATION_WHERE,
  StorageMigrationService,
  migrationNotConfigured,
  migrationTrigger,
} from './storage-migration.service';

/**
 * Storage console (ADMIN_KEYS): where document blobs live, antivirus verdicts, blobs retained or
 * purged after deletion, and the local → S3 migration (dry run or real run through the jobs
 * runner: same lease and MaintenanceRun history as the scheduler). Counts only — no document
 * content, name or key material.
 */
@Injectable()
export class StorageAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly antivirus: AntivirusService,
    private readonly migration: StorageMigrationService,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async status(now = new Date()) {
    const grace = this.env.DOCUMENT_PURGE_GRACE_DAYS;
    const [byDriver, byScan, retained, eligible, purged, pending, pendingSize] = await Promise.all([
      this.prisma.document.groupBy({
        by: ['storageDriver'],
        where: { blobPurgedAt: null },
        _count: { _all: true },
      }),
      this.prisma.document.groupBy({
        by: ['scanStatus'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.document.count({ where: { deletedAt: { not: null }, blobPurgedAt: null } }),
      this.prisma.document.count({ where: purgeEligibleWhere(now, grace) }),
      this.prisma.document.count({ where: { blobPurgedAt: { not: null } } }),
      this.prisma.document.count({ where: PENDING_MIGRATION_WHERE }),
      this.prisma.document.aggregate({ where: PENDING_MIGRATION_WHERE, _sum: { sizeBytes: true } }),
    ]);
    return {
      sandbox: true,
      activeDriver: this.env.STORAGE_DRIVER,
      antivirus: {
        provider: this.antivirus.provider,
        engine: this.antivirus.engine,
        /** The sandbox provider only recognises the EICAR test file. */
        simulation: this.antivirus.provider === 'sandbox',
      },
      documents: {
        blobsByDriver: byDriver
          .map((row) => ({ driver: row.storageDriver, count: row._count._all }))
          .sort((a, b) => a.driver.localeCompare(b.driver)),
        liveByScanStatus: byScan
          .map((row) => ({ status: row.scanStatus, count: row._count._all }))
          .sort((a, b) => a.status.localeCompare(b.status)),
      },
      purge: { graceDays: grace, retained, eligible, purged },
      migration: {
        ready: this.migration.ready,
        pending,
        /** Plaintext size of the pending documents (the sealed blobs are slightly larger). */
        pendingBytes: pendingSize._sum.sizeBytes ?? 0,
      },
    };
  }

  /** Runs STORAGE_MIGRATION now (dry run: verification only). 409 unless STORAGE_DRIVER=s3. */
  async migrate(auth: AuthContext, dryRun: boolean, req: Request) {
    if (!this.migration.ready) throw migrationNotConfigured();
    const run = await this.maintenance.run(
      MaintenanceJobName.STORAGE_MIGRATION,
      migrationTrigger(auth.userId, dryRun),
    );
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.storage_migration',
      entityType: 'MaintenanceRun',
      entityId: run.id,
      metadata: { dryRun, status: run.status, error: run.error ?? undefined },
      ...requestMeta(req),
    });
    return toRunDto(run);
  }
}
