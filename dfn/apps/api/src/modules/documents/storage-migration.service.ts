import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MaintenanceJobName, type Prisma } from '@dfn/database';
import { ErrorCode, StorageDriver } from '@dfn/shared';
import { sha256Hex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlobStoreRegistry } from '../../common/storage/blob-store.registry';
import { StorageError, isStorageError, rotationTempKey } from '../../common/storage/blob-store';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { JobRegistry, type JobContext, type JobResult } from '../jobs/job-registry';
import { WrappingIdCursor, actorFromTrigger } from './id-cursor';
import { DocumentStorageService } from './storage.service';

/** Documents examined per page, and at most per run (blobs are copied one by one). */
export const MIGRATION_PAGE_SIZE = 25;
export const MIGRATION_MAX_PER_RUN = 200;
/** A run stops starting new copies after this long; the remainder goes to the next run. */
const TIME_BUDGET_MS = 5 * 60_000;
const DRY_RUN_SUFFIX = ':dry-run';

/** `triggeredBy` of a run requested from the storage console (the dry-run flag travels with it). */
export function migrationTrigger(userId: string, dryRun: boolean): string {
  return `manual:${userId}${dryRun ? DRY_RUN_SUFFIX : ''}`;
}

export function isDryRunTrigger(triggeredBy: string): boolean {
  return triggeredBy.startsWith('manual:') && triggeredBy.endsWith(DRY_RUN_SUFFIX);
}

/** Documents whose blob still lives on the local driver (purged blobs have nothing to move). */
export const PENDING_MIGRATION_WHERE = {
  storageDriver: StorageDriver.LOCAL,
  blobPurgedAt: null,
} satisfies Prisma.DocumentWhereInput;

/** 409 when the migration is requested while new blobs are not written to S3. */
export function migrationNotConfigured(): DomainError {
  return new DomainError(
    ErrorCode.NOT_AVAILABLE,
    'Storage migration requires STORAGE_DRIVER=s3 (blobs are copied from local to the active S3 store)',
    HttpStatus.CONFLICT,
    { activeDriver: 'local', required: StorageDriver.S3 },
  );
}

type MigrationOutcome =
  | { kind: 'migrated' | 'ready'; bytes: number }
  | { kind: 'missing' | 'raced' }
  | { kind: 'failed'; reason: string };

interface MigrationCandidate {
  id: string;
  organizationId: string;
  storageKey: string;
  storageDriver: string;
  encryptionKeyId: string | null;
  sha256: string;
  deletedAt: Date | null;
}

export interface MigrationSummary {
  dryRun: boolean;
  from: 'local';
  to: 's3';
  scanned: number;
  /** Copied, verified, switched and removed from local (dry run: verified and ready to copy). */
  migrated: number;
  bytes: number;
  /** Deleted document whose local blob is already gone: nothing to copy (the purge stamps it). */
  missing: number;
  /** Changed concurrently (key rotation, purge): the copy was dropped, retried next run. */
  raced: number;
  failed: number;
  /** Local copies that could not be removed after the switch (harmless ciphertext, logged). */
  localCleanupFailed: number;
  remaining: number;
  errors?: Record<string, number>;
}

function failureReason(err: unknown): string {
  if (isStorageError(err)) return `STORAGE_${err.reason}`;
  if (err instanceof DomainError) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' ? reason : String(err.code);
  }
  return 'ERROR';
}

/**
 * STORAGE_MIGRATION — moves document blobs from the local driver to S3 once STORAGE_DRIVER=s3
 * (refused otherwise: a scheduled run is a no-op, a manual one fails). Per document:
 *
 *  1. read the local blob and verify it (authenticates with its key, hashes to Document.sha256):
 *     corrupted or unreadable content is never carried over — it stays local and is reported;
 *  2. write the same sealed bytes to S3 and read them back: the SHA-256 of the copy must equal
 *     the SHA-256 of the local sealed bytes, otherwise the copy is deleted;
 *  3. switch the row (storageDriver local → s3) with a compare-and-set on its driver, key,
 *     encryptionKeyId and blobPurgedAt — a concurrent key rotation or purge makes the switch fail
 *     and the S3 copy is dropped (retried next run); downloads follow the row (a read that misses
 *     the local copy re-reads the row);
 *  4. only then delete the local copy (and any leftover key-rotation copy).
 *
 * Deleted-but-retained documents are migrated too (their retention continues on S3). A dry run
 * (POST /v1/admin/storage/migration {dryRun:true}) performs step 1 only and reports counts and
 * bytes. Bounded, resumable (migrated rows no longer match), scans from a random point; each page
 * is audited per organisation (`document.blobs_migrated`), and each run that started by hand or
 * changed something (`storage.migration_run`). A deleted document whose local blob is gone because
 * it was deleted before the purge was deferred is recorded as purged (nothing left to move).
 */
@Injectable()
export class StorageMigrationService implements OnModuleInit {
  private readonly logger = new Logger(StorageMigrationService.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly prisma: PrismaService,
    private readonly stores: BlobStoreRegistry,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.registry.register(MaintenanceJobName.STORAGE_MIGRATION, (ctx) => this.run(ctx));
  }

  get ready(): boolean {
    return this.env.STORAGE_DRIVER === StorageDriver.S3;
  }

  async run(ctx: JobContext): Promise<JobResult> {
    if (!this.ready) {
      // The scheduler runs every registered job: on a local-only deployment this is a no-op.
      if (actorFromTrigger(ctx.triggeredBy)) throw migrationNotConfigured();
      return { summary: { skipped: 'STORAGE_DRIVER_NOT_S3', activeDriver: this.env.STORAGE_DRIVER } };
    }
    const dryRun = isDryRunTrigger(ctx.triggeredBy);
    const actorUserId = actorFromTrigger(ctx.triggeredBy);
    const summary: MigrationSummary = {
      dryRun,
      from: 'local',
      to: 's3',
      scanned: 0,
      migrated: 0,
      bytes: 0,
      missing: 0,
      raced: 0,
      failed: 0,
      localCleanupFailed: 0,
      remaining: 0,
    };
    // Once everything has moved, scheduled runs stop here (no request to S3, no audit record).
    if (!actorUserId && (await this.prisma.document.count({ where: PENDING_MIGRATION_WHERE })) === 0) {
      return { summary: { ...summary } };
    }
    // Nothing is read or moved while the destination is down.
    const health = await this.stores.forDriver(StorageDriver.S3).healthCheck();
    if (!health.ok) throw new StorageError('health', health.reason ?? 'UNREACHABLE', StorageDriver.S3);

    const deadline = Date.now() + TIME_BUDGET_MS;
    const shouldStop = () => Boolean(ctx.signal?.aborted) || Date.now() > deadline;
    const errors: Record<string, number> = {};
    const cursor = new WrappingIdCursor();

    while (summary.scanned < MIGRATION_MAX_PER_RUN && !shouldStop()) {
      const docs: MigrationCandidate[] = await this.prisma.document.findMany({
        where: { ...PENDING_MIGRATION_WHERE, id: cursor.idFilter },
        orderBy: { id: 'asc' },
        take: Math.min(MIGRATION_PAGE_SIZE, MIGRATION_MAX_PER_RUN - summary.scanned),
        select: {
          id: true,
          organizationId: true,
          storageKey: true,
          storageDriver: true,
          encryptionKeyId: true,
          sha256: true,
          deletedAt: true,
        },
      });
      if (docs.length === 0) {
        if (cursor.wrap()) continue;
        break;
      }
      const moved = new Map<string, string[]>();
      for (const doc of docs) {
        cursor.after = doc.id;
        summary.scanned += 1;
        const outcome = await this.migrateOne(doc, dryRun, summary);
        if (outcome.kind === 'failed') {
          summary.failed += 1;
          errors[outcome.reason] = (errors[outcome.reason] ?? 0) + 1;
        } else if (outcome.kind === 'migrated' || outcome.kind === 'ready') {
          summary.migrated += 1;
          summary.bytes += outcome.bytes;
          if (outcome.kind === 'migrated') {
            moved.set(doc.organizationId, [...(moved.get(doc.organizationId) ?? []), doc.id]);
          }
        } else {
          summary[outcome.kind] += 1;
        }
        if (shouldStop()) break;
      }
      for (const [organizationId, documentIds] of moved) {
        await this.audit.log({
          actorUserId,
          organizationId,
          action: 'document.blobs_migrated',
          entityType: 'Document',
          entityId: null,
          metadata: { from: 'local', to: 's3', location: health.location, documentIds, runId: ctx.runId },
        });
      }
    }
    summary.remaining = await this.prisma.document.count({ where: PENDING_MIGRATION_WHERE });
    if (summary.failed > 0) summary.errors = errors;
    if (actorUserId || summary.migrated + summary.failed + summary.raced > 0) {
      await this.audit.log({
        actorUserId,
        action: 'storage.migration_run',
        entityType: 'MaintenanceRun',
        entityId: ctx.runId ?? null,
        metadata: { triggeredBy: ctx.triggeredBy, location: health.location, ...summary },
      });
    }
    if (summary.scanned > 0) {
      this.logger.log(
        `storage migration${dryRun ? ' (dry run)' : ''}: migrated=${summary.migrated} failed=${summary.failed} remaining=${summary.remaining}`,
      );
    }
    return { summary: { ...summary } };
  }

  /** Moves (or, in a dry run, checks) one blob; never throws. */
  private async migrateOne(
    doc: MigrationCandidate,
    dryRun: boolean,
    summary: MigrationSummary,
  ): Promise<MigrationOutcome> {
    const source = this.stores.forDriver(StorageDriver.LOCAL);
    const target = this.stores.forDriver(StorageDriver.S3);
    try {
      let sealed: Buffer;
      try {
        sealed = await source.get(doc.storageKey);
      } catch (err) {
        if (doc.deletedAt && isStorageError(err, 'NOT_FOUND')) {
          // A deletion older than the deferred purge took its blob: recorded as purged (no longer
          // pending). Any other missing blob stays pending and reported.
          if (!dryRun) await this.storage.recordMissingDeletedBlob(doc);
          return { kind: 'missing' };
        }
        throw err;
      }
      await this.storage.openSealed(doc, sealed, null);
      if (dryRun) return { kind: 'ready', bytes: sealed.length };

      const digest = sha256Hex(sealed);
      await target.put(doc.storageKey, sealed, { contentType: 'application/octet-stream' });
      const copy = await target.get(doc.storageKey).catch(() => null);
      if (!copy || sha256Hex(copy) !== digest) {
        await target.delete(doc.storageKey).catch(() => undefined);
        return { kind: 'failed', reason: 'COPY_VERIFY_FAILED' };
      }

      const { count } = await this.prisma.document.updateMany({
        where: {
          id: doc.id,
          storageDriver: StorageDriver.LOCAL,
          storageKey: doc.storageKey,
          encryptionKeyId: doc.encryptionKeyId,
          blobPurgedAt: null,
        },
        data: { storageDriver: StorageDriver.S3 },
      });
      if (count === 0) {
        const row = await this.prisma.document.findUnique({
          where: { id: doc.id },
          select: { storageDriver: true, storageKey: true, blobPurgedAt: true },
        });
        const referenced =
          row &&
          !row.blobPurgedAt &&
          row.storageDriver === StorageDriver.S3 &&
          row.storageKey === doc.storageKey;
        if (!referenced) await target.delete(doc.storageKey).catch(() => undefined);
        return { kind: 'raced' };
      }

      try {
        await source.delete(doc.storageKey);
      } catch (err) {
        summary.localCleanupFailed += 1;
        this.logger.warn(
          `document ${doc.id}: local copy not removed after migration (${failureReason(err)})`,
        );
      }
      await source.delete(rotationTempKey(doc.id)).catch(() => undefined);
      return { kind: 'migrated', bytes: sealed.length };
    } catch (err) {
      const reason = failureReason(err);
      this.logger.warn(`document ${doc.id}: not migrated (${reason})`);
      return { kind: 'failed', reason };
    }
  }
}
