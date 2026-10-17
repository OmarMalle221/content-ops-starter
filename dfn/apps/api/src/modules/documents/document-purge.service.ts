import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MaintenanceJobName, type Prisma } from '@dfn/database';
import { StorageDriver } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlobStoreRegistry } from '../../common/storage/blob-store.registry';
import {
  StorageError,
  isStorageError,
  rotationTempKey,
  type BlobStore,
} from '../../common/storage/blob-store';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { JobRegistry, type JobContext, type JobResult } from '../jobs/job-registry';
import { WrappingIdCursor, actorFromTrigger } from './id-cursor';
import { DocumentStorageService } from './storage.service';

const DAY_MS = 86_400_000;
/** Documents examined per page, and at most per run (a run resumes where the previous stopped). */
export const PURGE_PAGE_SIZE = 100;
export const PURGE_MAX_PER_RUN = 1000;
/** A run stops starting new purges after this long; the remainder goes to the next run. */
const TIME_BUDGET_MS = 5 * 60_000;

/** Earliest purge of a deleted document's blob: max(deletedAt + grace, retentionUntil). */
export function purgeAfter(doc: { deletedAt: Date; retentionUntil: Date | null }, graceDays: number): Date {
  const grace = doc.deletedAt.getTime() + graceDays * DAY_MS;
  return new Date(Math.max(grace, doc.retentionUntil?.getTime() ?? 0));
}

/**
 * Evidence that holds a blob back: any milestone evidence, and evidence or dispute-message
 * attachments of a dispute that is not CLOSED.
 */
export const HELD_AS_EVIDENCE = {
  evidences: { some: { OR: [{ disputeId: null }, { dispute: { status: { not: 'CLOSED' } } }] } },
} satisfies Prisma.DocumentWhereInput;
export const HELD_BY_DISPUTE_MESSAGE = {
  disputeMessages: { some: { dispute: { status: { not: 'CLOSED' } } } },
} satisfies Prisma.DocumentWhereInput;

/** Deleted documents whose blob may be purged at `now`. */
export function purgeEligibleWhere(now: Date, graceDays: number): Prisma.DocumentWhereInput {
  return {
    deletedAt: { lte: new Date(now.getTime() - graceDays * DAY_MS) },
    blobPurgedAt: null,
    OR: [{ retentionUntil: null }, { retentionUntil: { lte: now } }],
    NOT: [HELD_AS_EVIDENCE, HELD_BY_DISPUTE_MESSAGE],
  };
}

type PurgeOutcome = 'purged' | 'missing' | 'raced' | { failed: string };

interface PurgeCandidate {
  id: string;
  organizationId: string;
  storageKey: string;
  storageDriver: string;
}

/** Per run and per driver: null once the store proved healthy, else the failure its blobs get. */
type HealthCache = Map<string, StorageError | null>;

export interface PurgeSummary {
  graceDays: number;
  scanned: number;
  purged: number;
  /**
   * Blob already absent AND the deletion predates the deferred purge (audit `document.deleted`
   * without `blobRetained`): recorded as purged. Any other absent blob is a failure
   * (STORAGE_NOT_FOUND) and the row is never stamped.
   */
  missing: number;
  /** Changed concurrently (e.g. moved by the storage migration): left for the next run. */
  raced: number;
  /** Store unavailable, retained blob missing, or a storage error: retried by the next run. */
  failed: number;
  /** Eligible blobs still to purge after this run (failures included). */
  remaining: number;
  /** Rows purged since the previous run whose blob location was deleted once more. */
  reswept: number;
  /** Failure counts by reason — reasons only. */
  errors?: Record<string, number>;
}

function failureReason(err: unknown): string {
  if (isStorageError(err)) return `STORAGE_${err.reason}`;
  if (err instanceof DomainError) return String(err.code);
  return 'ERROR';
}

/**
 * DOCUMENT_PURGE — destroys the encrypted blob of deleted documents once their retention allows
 * it, i.e. after max(deletedAt + DOCUMENT_PURGE_GRACE_DAYS, retentionUntil), and never while the
 * document is still evidence (milestone evidence, or evidence / message attachment of a dispute
 * that is not CLOSED). Deleting a document only soft-deletes the row: until this job runs, the
 * blob stays available to compliance.
 *
 * Per document: delete the blob (and any leftover key-rotation copy), stamp Document.blobPurgedAt
 * with a compare-and-set on the blob location (a document the storage migration moved meanwhile
 * is left for the next run), then delete once more against a key-rotation swap racing with the
 * purge. A row is stamped only when this job — or a deletion that predates the deferred purge —
 * destroyed its blob, never because the blob merely cannot be found:
 *  - the store of each driver is health-checked once per run; while it is unreachable,
 *    misconfigured or not writable, its documents are counted failed and nothing is stamped (an
 *    unmounted volume or a wrong bucket must not mass-mark rows as purged and orphan their
 *    ciphertext, which no job would ever revisit);
 *  - a blob absent from a healthy store is recorded as purged only when the document was deleted
 *    before the purge was deferred (`DocumentStorageService.recordMissingDeletedBlob`, the rule the
 *    rotation and the migration apply); otherwise it is an anomaly counted STORAGE_NOT_FOUND,
 *    retried by every run and visible in `remaining` until an operator resolves it.
 * Each run also deletes once more the location of the rows purged since the previous run started:
 * a rotation (or migration) replica that wrote its copy after this job's second delete and crashed
 * before its own compare-and-set would otherwise leave that copy behind a purged row for good.
 *
 * Idempotent and resumable: purged rows no longer match, runs are bounded (pages, a per-run cap,
 * a time budget, the lease signal) and scan from a random point. Each page with purges is audited
 * per organisation (`document.blobs_purged`, ids only); the summary carries counts for metrics.
 */
@Injectable()
export class DocumentPurgeService implements OnModuleInit {
  private readonly logger = new Logger(DocumentPurgeService.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly prisma: PrismaService,
    private readonly stores: BlobStoreRegistry,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.registry.register(MaintenanceJobName.DOCUMENT_PURGE, (ctx) => this.run(ctx));
  }

  get graceDays(): number {
    return this.env.DOCUMENT_PURGE_GRACE_DAYS;
  }

  async run(ctx: JobContext, now = new Date()): Promise<JobResult> {
    const deadline = Date.now() + TIME_BUDGET_MS;
    const shouldStop = () => Boolean(ctx.signal?.aborted) || Date.now() > deadline;
    const where = purgeEligibleWhere(now, this.graceDays);
    const summary: PurgeSummary = {
      graceDays: this.graceDays,
      scanned: 0,
      purged: 0,
      missing: 0,
      raced: 0,
      failed: 0,
      remaining: 0,
      reswept: 0,
    };
    const errors: Record<string, number> = {};
    const health: HealthCache = new Map();
    const cursor = new WrappingIdCursor();

    summary.reswept = await this.resweepRecentlyPurged(ctx, health);
    while (summary.scanned < PURGE_MAX_PER_RUN && !shouldStop()) {
      const docs: PurgeCandidate[] = await this.prisma.document.findMany({
        where: { ...where, id: cursor.idFilter },
        orderBy: { id: 'asc' },
        take: Math.min(PURGE_PAGE_SIZE, PURGE_MAX_PER_RUN - summary.scanned),
        select: { id: true, organizationId: true, storageKey: true, storageDriver: true },
      });
      if (docs.length === 0) {
        if (cursor.wrap()) continue;
        break;
      }
      const page: Array<{ doc: PurgeCandidate; outcome: PurgeOutcome }> = [];
      for (const doc of docs) {
        cursor.after = doc.id;
        summary.scanned += 1;
        const outcome = await this.purgeOne(doc, health);
        page.push({ doc, outcome });
        if (typeof outcome === 'string') summary[outcome] += 1;
        else {
          summary.failed += 1;
          errors[outcome.failed] = (errors[outcome.failed] ?? 0) + 1;
        }
        if (shouldStop()) break;
      }
      await this.auditPage(page, ctx);
    }
    summary.remaining = await this.prisma.document.count({ where });
    if (summary.failed > 0) summary.errors = errors;
    if (summary.purged + summary.missing + summary.failed + summary.reswept > 0) {
      this.logger.log(
        `document purge: purged=${summary.purged} missing=${summary.missing} failed=${summary.failed} reswept=${summary.reswept} remaining=${summary.remaining}`,
      );
    }
    return { summary: { ...summary } };
  }

  /** Purges one blob; never throws (failures are counted and retried by the next run). */
  private async purgeOne(doc: PurgeCandidate, health: HealthCache): Promise<PurgeOutcome> {
    try {
      const store = await this.healthyStore(doc.storageDriver, health);
      if (!(await store.exists(doc.storageKey))) {
        // Only a deletion older than the deferred purge explains an absent blob: that row is
        // recorded as purged (`document.blob_missing`), as the rotation and the migration do. Any
        // other absence is a retained blob that should be there (volume not mounted, wrong bucket,
        // blobs restored from an older backup): reported, never stamped, retried by the next run.
        if (!(await this.storage.recordMissingDeletedBlob(doc))) {
          throw new StorageError('exists', 'NOT_FOUND', store.driver);
        }
        await store.delete(rotationTempKey(doc.id)).catch(() => undefined);
        return 'missing';
      }
      await store.delete(doc.storageKey);
      await store.delete(rotationTempKey(doc.id)).catch(() => undefined);
      const { count } = await this.prisma.document.updateMany({
        where: {
          id: doc.id,
          deletedAt: { not: null },
          blobPurgedAt: null,
          storageDriver: doc.storageDriver,
          storageKey: doc.storageKey,
        },
        data: { blobPurgedAt: new Date() },
      });
      if (count === 0) return 'raced';
      // A key-rotation swap that raced with the first delete may have written the blob again.
      await store.delete(doc.storageKey).catch((err: unknown) => {
        this.logger.warn(`document ${doc.id}: second purge delete failed (${failureReason(err)})`);
      });
      return 'purged';
    } catch (err) {
      const reason = failureReason(err);
      this.logger.warn(`document ${doc.id}: blob not purged (${reason})`);
      return { failed: reason };
    }
  }

  /**
   * Store of `driver`, once its health was verified for this run (one probe per driver per run).
   * Throws the StorageError every blob of an unavailable driver is counted with — no blob of that
   * driver is read, deleted or stamped while its store cannot answer for what it holds.
   */
  private async healthyStore(driver: string, cache: HealthCache): Promise<BlobStore> {
    let failure = cache.get(driver);
    if (failure === undefined) {
      failure = await this.probe(driver);
      cache.set(driver, failure);
      if (failure) {
        this.logger.warn(
          `document purge: ${driver} storage unavailable (${failure.reason}); its blobs are left untouched this run`,
        );
      }
    }
    if (failure) throw failure;
    return this.stores.forDriver(driver);
  }

  /** Health of a driver's store as the StorageError to raise, or null when it is reachable. */
  private async probe(driver: string): Promise<StorageError | null> {
    try {
      const health = await this.stores.forDriver(driver).healthCheck();
      return health.ok ? null : new StorageError('health', health.reason ?? 'UNREACHABLE', health.driver);
    } catch (err) {
      return isStorageError(err) ? err : new StorageError('health', 'MISCONFIGURED');
    }
  }

  /**
   * Deletes once more the blob location (and rotation copy) of the rows purged since the previous
   * run started. A key-rotation replica that wrote its re-sealed blob after this job's second
   * delete and crashed before its own compare-and-set — or a migration replica that crashed
   * between its S3 copy and its switch — would otherwise leave an encrypted copy behind a purged
   * row that no job revisits. Idempotent, bounded to one run's worth of rows, best effort.
   */
  private async resweepRecentlyPurged(ctx: JobContext, health: HealthCache): Promise<number> {
    const previous = await this.prisma.maintenanceRun.findFirst({
      where: {
        jobName: MaintenanceJobName.DOCUMENT_PURGE,
        ...(ctx.runId ? { id: { not: ctx.runId } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    if (!previous) return 0;
    const rows = await this.prisma.document.findMany({
      where: { blobPurgedAt: { gte: previous.startedAt } },
      orderBy: { blobPurgedAt: 'desc' },
      take: PURGE_MAX_PER_RUN,
      select: { id: true, storageKey: true, storageDriver: true },
    });
    let reswept = 0;
    for (const row of rows) {
      if (ctx.signal?.aborted) break;
      // An unavailable store is logged once by healthyStore; its rows are simply skipped.
      const store = await this.healthyStore(row.storageDriver, health).catch(() => null);
      if (!store) continue;
      try {
        await store.delete(row.storageKey);
        await store.delete(rotationTempKey(row.id)).catch(() => undefined);
        // While blobs move to S3, a copy left by a crashed migration replica lives under the same
        // key on the active driver.
        if (row.storageDriver === StorageDriver.LOCAL && this.stores.activeDriver === StorageDriver.S3) {
          const target = await this.healthyStore(StorageDriver.S3, health).catch(() => null);
          await target?.delete(row.storageKey);
        }
        reswept += 1;
      } catch (err) {
        this.logger.warn(`document ${row.id}: purged location not re-swept (${failureReason(err)})`);
      }
    }
    return reswept;
  }

  /** One audit record per organisation of the page: purged and missing ids, failure count. */
  private async auditPage(page: Array<{ doc: PurgeCandidate; outcome: PurgeOutcome }>, ctx: JobContext) {
    const byOrg = new Map<string, { purged: string[]; missing: string[]; failed: number }>();
    for (const { doc, outcome } of page) {
      if (outcome === 'raced') continue;
      const entry = byOrg.get(doc.organizationId) ?? { purged: [], missing: [], failed: 0 };
      if (outcome === 'purged') entry.purged.push(doc.id);
      else if (outcome === 'missing') entry.missing.push(doc.id);
      else entry.failed += 1;
      byOrg.set(doc.organizationId, entry);
    }
    for (const [organizationId, entry] of byOrg) {
      if (entry.purged.length === 0 && entry.missing.length === 0 && entry.failed === 0) continue;
      await this.audit.log({
        actorUserId: actorFromTrigger(ctx.triggeredBy),
        organizationId,
        action: 'document.blobs_purged',
        entityType: 'Document',
        entityId: null,
        metadata: {
          documentIds: entry.purged,
          missingDocumentIds: entry.missing,
          failed: entry.failed,
          graceDays: this.graceDays,
          triggeredBy: ctx.triggeredBy,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        },
      });
    }
  }
}
