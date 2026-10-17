import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ErrorCode, KeyPurpose } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { keyRingFor, type KeyRing } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isStorageError } from '../../common/storage/blob-store';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { DocumentStorageService } from '../documents/storage.service';
import { JobRegistry, type JobResult } from '../jobs/job-registry';
import { pendingDocumentsWhere } from './key-usage';
import { ManagedKeysService, validatedKeyRing } from './managed-keys.service';
import {
  SEALED_COLUMNS,
  ZERO_UUID,
  countPending,
  pendingRows,
  replaceIfUnchanged,
  type SealedColumn,
} from './sealed-columns';

export { pendingDocumentsWhere } from './key-usage';

export const KEY_ROTATION_JOB = 'ENCRYPTION_KEY_ROTATION' as const;

/** Every key purpose, in the order they are rotated and displayed. */
export const KEY_PURPOSES: readonly KeyPurpose[] = [
  KeyPurpose.DOCUMENTS,
  KeyPurpose.MFA,
  KeyPurpose.WEBHOOKS,
  KeyPurpose.BENEFICIARIES,
];

/** Values re-sealed per purpose and per run (documents are blobs: smaller batch). */
export const ROTATION_BATCH: Readonly<Record<KeyPurpose, number>> = {
  [KeyPurpose.DOCUMENTS]: 50,
  [KeyPurpose.MFA]: 200,
  [KeyPurpose.WEBHOOKS]: 200,
  [KeyPurpose.BENEFICIARIES]: 200,
};
/**
 * Scan position of one run: it starts at a random point of the id space and wraps around once.
 * Rows that keep failing therefore cannot pin every run to the same window (a fixed start would
 * re-scan the same failures forever once SCAN_FACTOR × batch of them sort first).
 */
export class WrappingCursor {
  private readonly start: string;
  private wrapped = false;
  after: string;

  constructor(start: string = randomUUID()) {
    this.start = start;
    this.after = start;
  }

  /** Inclusive upper bound once wrapped (ids up to the starting point). */
  get until(): string | undefined {
    return this.wrapped ? this.start : undefined;
  }

  /** Called when a page comes back empty: false once the whole space has been covered. */
  wrap(): boolean {
    if (this.wrapped) return false;
    this.wrapped = true;
    this.after = ZERO_UUID;
    return true;
  }
}

/** Candidates examined per purpose and per run, as a multiple of the batch (skips past failures). */
const SCAN_FACTOR = 5;
const PAGE_SIZE = 100;
/** A run stops starting new rows after this long; the remainder is picked up by the next run. */
const TIME_BUDGET_MS = 5 * 60_000;

export interface PurposeRotationSummary {
  activeKeyId: string;
  scanned: number;
  rotated: number;
  failed: number;
  remaining: number;
  /** Documents whose blob was already sealed with the active key (row fixed after a crash). */
  repaired?: number;
  /** Failure counts by reason — reasons only, never values or key material. */
  errors?: Record<string, number>;
  /**
   * Set when the purpose was not rotated: its ACTIVE managed key could not be loaded by this
   * replica (rotating towards its fallback key would undo the activation).
   */
  skipped?: 'ACTIVE_KEY_NOT_LOADED';
}

const PURPOSE_SUFFIX = /:purpose=([a-z]+)$/;
const MANUAL_ACTOR = /^manual:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** `triggeredBy` of a run requested from the keys console (the purpose travels with the run). */
export function rotationTrigger(userId: string, purpose?: KeyPurpose): string {
  return purpose ? `manual:${userId}:purpose=${purpose}` : `manual:${userId}`;
}

/** Purpose restriction carried by `triggeredBy`, or null for every purpose (scheduler, jobs console). */
export function purposeFromTrigger(triggeredBy: string): KeyPurpose | null {
  const match = PURPOSE_SUFFIX.exec(triggeredBy);
  const value = match?.[1];
  return value && (KEY_PURPOSES as readonly string[]).includes(value) ? (value as KeyPurpose) : null;
}

function actorFromTrigger(triggeredBy: string): string | null {
  return MANUAL_ACTOR.exec(triggeredBy)?.[1]?.toLowerCase() ?? null;
}

/** Stable, secret-free failure label for summaries and audit. */
function failureReason(err: unknown): string {
  if (isStorageError(err)) return `STORAGE_${err.reason}`;
  if (err instanceof DomainError) {
    if (err.code === ErrorCode.KEY_NOT_FOUND) return 'KEY_NOT_FOUND';
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' ? reason : String(err.code);
  }
  if (err instanceof RotationFailure) return err.reason;
  return 'ERROR';
}

class RotationFailure extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * ENCRYPTION_KEY_ROTATION — re-seals with the active key every value still sealed with another
 * key: MFA secrets, webhook signing secrets, beneficiary account identifiers and document blobs
 * (blobs of deleted documents included while they are retained, i.e. until DOCUMENT_PURGE).
 *
 * Runs through MaintenanceService (advisory lock + MaintenanceRun history), from the scheduler, on
 * demand (/v1/admin/jobs/ENCRYPTION_KEY_ROTATION/run, /v1/admin/keys/rotate) or right after
 * KEY_LIFECYCLE activated a managed key. The managed keys are refreshed first. Each run is
 * bounded (ROTATION_BATCH values per purpose, a scan cap and a time budget) and idempotent:
 * already-rotated values are not selected again, so successive runs resume where the previous one
 * stopped and a run with nothing left to do is a no-op. String values are replaced with a
 * compare-and-set (a value changed concurrently is left for the next run). Every run is audited.
 */
@Injectable()
export class KeyRotationService implements OnModuleInit {
  private readonly logger = new Logger(KeyRotationService.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly prisma: PrismaService,
    private readonly documents: DocumentStorageService,
    private readonly audit: AuditService,
    private readonly managed: ManagedKeysService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    validatedKeyRing(this.env);
    this.registry.register(KEY_ROTATION_JOB, (ctx) => this.run(ctx));
  }

  private get ring(): KeyRing {
    return keyRingFor(this.env);
  }

  /** Job handler. `signal` is honoured when the jobs runner provides one. */
  async run(ctx: { triggeredBy: string; signal?: AbortSignal }): Promise<JobResult> {
    const only = purposeFromTrigger(ctx.triggeredBy);
    const deadline = Date.now() + TIME_BUDGET_MS;
    // Rotate towards the active keys recorded in the database, not a view up to
    // KEYRING_REFRESH_SECONDS old (a key activated by another replica would otherwise be undone).
    await this.managed.refresh();
    const shouldStop = () => Boolean(ctx.signal?.aborted) || Date.now() > deadline;

    const purposes: Partial<Record<KeyPurpose, PurposeRotationSummary>> = {};
    for (const purpose of KEY_PURPOSES) {
      if (only && purpose !== only) continue;
      const spec = SEALED_COLUMNS.find((c) => c.purpose === purpose);
      const unloaded = this.managed.unloadedActiveKeyId(purpose);
      if (unloaded) {
        purposes[purpose] = await this.skipped(purpose, unloaded, spec);
        continue;
      }
      purposes[purpose] =
        purpose === KeyPurpose.DOCUMENTS
          ? await this.rotateDocuments(shouldStop)
          : await this.rotateColumn(spec!, shouldStop);
    }
    const all = Object.values(purposes);
    const summary = {
      purpose: only ?? 'all',
      scanned: all.reduce((n, p) => n + p.scanned, 0),
      rotated: all.reduce((n, p) => n + p.rotated, 0),
      failed: all.reduce((n, p) => n + p.failed, 0),
      remaining: all.reduce((n, p) => n + p.remaining, 0),
      purposes,
    };
    await this.audit.log({
      actorUserId: actorFromTrigger(ctx.triggeredBy),
      action: 'keys.rotation_run',
      entityType: 'KeyRing',
      entityId: null,
      metadata: { triggeredBy: ctx.triggeredBy, ...summary },
    });
    if (summary.rotated > 0 || summary.failed > 0) {
      this.logger.log(
        `key rotation (${summary.purpose}): rotated=${summary.rotated} failed=${summary.failed} remaining=${summary.remaining}`,
      );
    }
    return { summary };
  }

  /** Summary of a purpose left alone because its ACTIVE managed key is not loaded here. */
  private async skipped(
    purpose: KeyPurpose,
    activeKeyId: string,
    spec: SealedColumn | undefined,
  ): Promise<PurposeRotationSummary> {
    this.logger.error(`key rotation of ${purpose} skipped: active key ${activeKeyId} is not loaded here`);
    const remaining =
      purpose === KeyPurpose.DOCUMENTS
        ? await this.prisma.document.count({ where: pendingDocumentsWhere(activeKeyId) })
        : await countPending(this.prisma, spec!, activeKeyId);
    return { activeKeyId, scanned: 0, rotated: 0, failed: 0, remaining, skipped: 'ACTIVE_KEY_NOT_LOADED' };
  }

  /** Re-seals one string column in a bounded batch. */
  async rotateColumn(spec: SealedColumn, shouldStop: () => boolean): Promise<PurposeRotationSummary> {
    const ring = this.ring;
    const active = ring.activeKeyId(spec.purpose);
    const batch = ROTATION_BATCH[spec.purpose];
    const scanCap = batch * SCAN_FACTOR;
    const result: PurposeRotationSummary = {
      activeKeyId: active,
      scanned: 0,
      rotated: 0,
      failed: 0,
      remaining: 0,
    };
    const errors: Record<string, number> = {};
    const cursor = new WrappingCursor();

    outer: while (result.rotated < batch && result.scanned < scanCap && !shouldStop()) {
      const rows = await pendingRows(
        this.prisma,
        spec,
        active,
        cursor.after,
        Math.min(PAGE_SIZE, scanCap - result.scanned),
        cursor.until,
      );
      if (rows.length === 0) {
        if (cursor.wrap()) continue;
        break;
      }
      for (const row of rows) {
        cursor.after = row.id;
        result.scanned += 1;
        try {
          const keyId = ring.keyIdOfString(row.value);
          if (!ring.hasKey(spec.purpose, keyId)) throw new RotationFailure('KEY_NOT_FOUND');
          let plaintext: string;
          try {
            plaintext = ring.openString(spec.purpose, row.value);
          } catch {
            throw new RotationFailure('DECRYPT_FAILED');
          }
          const next = ring.sealString(spec.purpose, plaintext);
          if (await replaceIfUnchanged(this.prisma, spec, row.id, row.value, next)) result.rotated += 1;
        } catch (err) {
          result.failed += 1;
          const reason = failureReason(err);
          errors[reason] = (errors[reason] ?? 0) + 1;
        }
        if (result.rotated >= batch || shouldStop()) break outer;
      }
    }
    result.remaining = await countPending(this.prisma, spec, active);
    if (result.failed > 0) result.errors = errors;
    return result;
  }

  /** Re-seals document blobs in a bounded batch (see DocumentStorageService.reseal). */
  async rotateDocuments(shouldStop: () => boolean): Promise<PurposeRotationSummary> {
    const active = this.ring.activeKeyId(KeyPurpose.DOCUMENTS);
    const batch = ROTATION_BATCH[KeyPurpose.DOCUMENTS];
    const scanCap = batch * SCAN_FACTOR;
    const result: PurposeRotationSummary = {
      activeKeyId: active,
      scanned: 0,
      rotated: 0,
      failed: 0,
      remaining: 0,
      repaired: 0,
    };
    const errors: Record<string, number> = {};
    const pending = pendingDocumentsWhere(active);
    const cursor = new WrappingCursor();

    outer: while (result.rotated < batch && result.scanned < scanCap && !shouldStop()) {
      const until = cursor.until;
      const docs = await this.prisma.document.findMany({
        where: { ...pending, id: until ? { gt: cursor.after, lte: until } : { gt: cursor.after } },
        orderBy: { id: 'asc' },
        take: Math.min(PAGE_SIZE, scanCap - result.scanned),
        select: {
          id: true,
          organizationId: true,
          storageKey: true,
          storageDriver: true,
          encryptionKeyId: true,
          sha256: true,
        },
      });
      if (docs.length === 0) {
        if (cursor.wrap()) continue;
        break;
      }
      for (const doc of docs) {
        cursor.after = doc.id;
        result.scanned += 1;
        try {
          const outcome = await this.documents.reseal(doc);
          if (outcome === 'rotated') result.rotated += 1;
          if (outcome === 'repaired') {
            result.rotated += 1;
            result.repaired! += 1;
          }
        } catch (err) {
          result.failed += 1;
          const reason = failureReason(err);
          errors[reason] = (errors[reason] ?? 0) + 1;
          this.logger.warn(`document ${doc.id} not rotated: ${reason}`);
        }
        if (result.rotated >= batch || shouldStop()) break outer;
      }
    }
    result.remaining = await this.prisma.document.count({ where: pending });
    if (result.failed > 0) result.errors = errors;
    return result;
  }
}
