import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import type { EncryptionKey, PrismaTransactionClient } from '@dfn/database';
import {
  ErrorCode,
  KeyPurpose,
  ManagedKeyStatus,
  StepUpOperation,
  type GenerateManagedKeyInput,
  type RetireManagedKeyInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { kmsFailureReason, kmsUnavailable, type KmsProvider } from '../../common/kms';
import { MANAGED_KEY_PREFIX, keyRingFor } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { MfaVerifierService } from '../auth/mfa-verifier.service';
import { JobRegistry, type JobContext, type JobResult } from '../jobs/job-registry';
import { MaintenanceService } from '../jobs/maintenance.service';
import { KEY_PURPOSES, KEY_ROTATION_JOB } from './key-rotation.service';
import { keyReferences } from './key-usage';
import { ManagedKeysService } from './managed-keys.service';

export const KEY_LIFECYCLE_JOB = 'KEY_LIFECYCLE' as const;
const DAY_MS = 24 * 3600_000;

/** Columns of a managed key that may leave the API (never the wrapped key). */
export const MANAGED_KEY_SELECT = {
  id: true,
  purpose: true,
  keyId: true,
  status: true,
  kmsProvider: true,
  kmsKeyRef: true,
  activateAfter: true,
  activatedAt: true,
  deactivatedAt: true,
  retiredAt: true,
  createdByUserId: true,
  createdAt: true,
} as const;
export type ManagedKeyRow = Pick<EncryptionKey, keyof typeof MANAGED_KEY_SELECT>;

/** `kms-YYYYMMDD-xxxxxx` (UTC date of creation, 24 random bits). */
export function newManagedKeyId(now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${MANAGED_KEY_PREFIX}${day}-${randomBytes(3).toString('hex')}`;
}

function lifecycleConflict(reason: string, message: string, details: Record<string, unknown> = {}) {
  return new DomainError(ErrorCode.KEY_LIFECYCLE_CONFLICT, message, HttpStatus.CONFLICT, {
    reason,
    ...details,
  });
}

/** Serialises lifecycle transitions of one purpose (generate, activate, retire) across replicas. */
async function lockPurpose(tx: PrismaTransactionClient, purpose: KeyPurpose) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dfn:encryption-key:${purpose}`}))`;
}

interface StageActor {
  userId: string | null;
  trigger: 'manual' | 'scheduled';
  req?: Request;
}

export interface LifecycleSummary {
  kmsProvider: string;
  activated: Array<{ purpose: KeyPurpose; keyId: string; previousKeyId: string | null }>;
  staged: Array<{ purpose: KeyPurpose; keyId: string; activateAfter: string; reason: string }>;
  skipped: Array<{ purpose: KeyPurpose; keyId?: string; reason: string }>;
  rotation: { runId?: string; status: string; reason?: string } | null;
}

/**
 * Lifecycle of KMS-managed data keys (ADR-0014): STAGED → ACTIVE → DECRYPT_ONLY → RETIRED.
 *
 * - generate (admin, second factor): a 32-byte random data key is wrapped by the KMS (round trip
 *   verified before the second factor is consumed and before anything is stored) and recorded
 *   STAGED with activateAfter = now + KEY_ACTIVATION_DELAY_SECONDS, so every replica has loaded it
 *   (decrypt-only) before it seals;
 * - KEY_LIFECYCLE job: promotes due STAGED keys (previous ACTIVE → DECRYPT_ONLY) in one
 *   transaction per purpose, under an advisory lock and the "one ACTIVE per purpose" partial
 *   unique index; stages a new key when the active one is older than KEY_ROTATION_INTERVAL_DAYS;
 *   then runs ENCRYPTION_KEY_ROTATION so stored values move to the new key;
 * - retire (admin, second factor): DECRYPT_ONLY → RETIRED only when nothing references the key
 *   any more, and not before every replica has stopped sealing with it.
 * Every transition is audited, with ids and counts only.
 */
@Injectable()
export class KeyLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(KeyLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly maintenance: MaintenanceService,
    private readonly managed: ManagedKeysService,
    private readonly audit: AuditService,
    private readonly mfa: MfaVerifierService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.registry.register(KEY_LIFECYCLE_JOB, (ctx) => this.run(ctx));
  }

  /** A DECRYPT_ONLY key may be retired this long after its deactivation (two refresh periods). */
  get retireGraceMs(): number {
    return 2 * this.env.KEYRING_REFRESH_SECONDS * 1000;
  }

  private requireProvider(): KmsProvider {
    if (!this.managed.provider) {
      throw lifecycleConflict(
        'KMS_NOT_CONFIGURED',
        'Managed keys need a KMS: set KMS_PROVIDER=local or aws (docs/operations/KEY_ROTATION.md)',
      );
    }
    return this.managed.provider;
  }

  /**
   * Key management is a high-impact act: when the acting ADMIN has a second factor (TOTP or a
   * passkey), a fresh proof is required (same rule as regulatory gates). A passkey proof must have
   * been issued for this very action — `keys.manage` on the purpose being generated for, or on the
   * key id being retired — exactly as the console requests it; a proof issued for anything else is
   * refused (403 STEP_UP_OPERATION_MISMATCH). Codes are single use whatever they authorise.
   */
  private async requireStepUp(
    auth: AuthContext,
    proof: GenerateManagedKeyInput | RetireManagedKeyInput,
    resourceId: string,
    req: Request,
  ): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        mfaEnabled: true,
        _count: { select: { webAuthnCredentials: { where: { revokedAt: null } } } },
      },
    });
    if (!user?.mfaEnabled && !user?._count.webAuthnCredentials) return null;
    return this.mfa.assertFreshProof(
      auth,
      proof,
      { operation: StepUpOperation.KEY_MANAGE, resourceId },
      {
        code: ErrorCode.STEP_UP_REQUIRED,
        message: 'A fresh second factor (TOTP, recovery code or passkey) is required to manage keys',
      },
      req,
    );
  }

  private async stagedKey(purpose: KeyPurpose, db: PrismaTransactionClient | PrismaService = this.prisma) {
    return db.encryptionKey.findFirst({
      where: { purpose, status: ManagedKeyStatus.STAGED },
      select: { keyId: true, activateAfter: true },
    });
  }

  // ── generate ────────────────────────────────────────────────────────────────

  /** POST /v1/admin/keys/:purpose/generate */
  async generate(auth: AuthContext, purpose: KeyPurpose, proof: GenerateManagedKeyInput, req: Request) {
    this.requireProvider();
    // Predictable refusals come before the second factor, so they never burn a code — the KMS
    // round trip of stage() too: a KMS outage must not cost a single-use recovery code.
    const staged = await this.stagedKey(purpose);
    if (staged) {
      throw lifecycleConflict('STAGED_KEY_EXISTS', `A staged key already waits for activation (${purpose})`, {
        purpose,
        keyId: staged.keyId,
        activateAfter: staged.activateAfter,
      });
    }
    return this.stage(purpose, { userId: auth.userId, trigger: 'manual', req }, () =>
      this.requireStepUp(auth, proof, purpose, req),
    );
  }

  /**
   * Creates a STAGED key for the purpose. The data key exists in clear only in this function and
   * in the ring cache (after the refresh unwraps it again through the KMS). `proveStepUp`, when
   * given, runs once the KMS round trip has succeeded, inside the transaction that holds the
   * purpose lock and has checked that no staged key exists, and before anything is stored: a code
   * is consumed only for a key the KMS has actually wrapped AND that is about to be recorded — the
   * losing side of two concurrent generates answers 409 STAGED_KEY_EXISTS with its code intact
   * (the random data key does not depend on the proof, and is discarded on any failure).
   */
  private async stage(
    purpose: KeyPurpose,
    actor: StageActor,
    proveStepUp: (() => Promise<string | null>) | null,
  ): Promise<ManagedKeyRow> {
    const provider = this.requireProvider();
    const dataKey = randomBytes(32);
    let row: ManagedKeyRow | null = null;
    let stepUp: string | null = null;
    try {
      for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
        const now = new Date();
        const keyId = newManagedKeyId(now);
        const context = { purpose, keyId };
        const wrapped = await provider.wrap(dataKey, context);
        // A key the KMS cannot unwrap must never be recorded: no replica could load it.
        const check = await provider.unwrap(wrapped, context, provider.keyRef);
        const roundTrip = check.equals(dataKey);
        check.fill(0);
        if (!roundTrip) throw kmsUnavailable(provider.name, 'unwrap', 'INVALID_CIPHERTEXT');
        row = await this.prisma.$transaction(
          async (tx) => {
            await lockPurpose(tx, purpose);
            const staged = await this.stagedKey(purpose, tx);
            if (staged) {
              throw lifecycleConflict(
                'STAGED_KEY_EXISTS',
                `A staged key already waits for activation (${purpose})`,
                {
                  purpose,
                  keyId: staged.keyId,
                  activateAfter: staged.activateAfter,
                },
              );
            }
            const taken = await tx.encryptionKey.findUnique({
              where: { purpose_keyId: { purpose, keyId } },
              select: { id: true },
            });
            if (taken) return null; // 24-bit suffix collision: draw another id (no proof asked yet)
            // The second factor is checked (and consumed) only now: the KMS has answered, the lock
            // is held and nothing stands in the way of this key being recorded. The proof writes
            // through the pool (code burnt, TOTP step recorded) — its outcome is final whatever this
            // transaction does, as a consumed code must be.
            if (proveStepUp) stepUp = await proveStepUp();
            return tx.encryptionKey.create({
              data: {
                purpose,
                keyId,
                status: ManagedKeyStatus.STAGED,
                wrappedKey: new Uint8Array(wrapped),
                kmsProvider: provider.name,
                kmsKeyRef: provider.keyRef,
                activateAfter: new Date(now.getTime() + this.env.KEY_ACTIVATION_DELAY_SECONDS * 1000),
                createdByUserId: actor.userId,
              },
              select: MANAGED_KEY_SELECT,
            });
          },
          // The proof (a few statements, an audit record, a notification) runs under the lock: a
          // concurrent generate waits for it, so both bounds are above Prisma's defaults (2 s / 5 s).
          { maxWait: 5_000, timeout: 15_000 },
        );
      }
    } finally {
      dataKey.fill(0);
    }
    if (!row) throw lifecycleConflict('KEY_ID_COLLISION', 'Could not allocate a unique key id, try again');
    await this.audit.log({
      actorUserId: actor.userId,
      action: 'keys.generated',
      entityType: 'EncryptionKey',
      entityId: row.id,
      metadata: {
        purpose,
        keyId: row.keyId,
        kmsProvider: row.kmsProvider,
        kmsKeyRef: row.kmsKeyRef,
        activateAfter: row.activateAfter?.toISOString() ?? null,
        trigger: actor.trigger,
        ...(stepUp ? { stepUp } : {}),
      },
      ...(actor.req ? requestMeta(actor.req) : {}),
    });
    // This replica loads it now; the others within KEYRING_REFRESH_SECONDS (before activateAfter).
    await this.managed.refresh();
    return row;
  }

  // ── retire ──────────────────────────────────────────────────────────────────

  /** Why a key cannot be retired yet (null = it can). */
  async retireBlocker(
    row: Pick<ManagedKeyRow, 'purpose' | 'keyId' | 'status' | 'deactivatedAt'>,
    now = new Date(),
  ): Promise<{ reason: string; message: string; details: Record<string, unknown> } | null> {
    if (row.status !== ManagedKeyStatus.DECRYPT_ONLY) {
      return {
        reason: 'NOT_DECRYPT_ONLY',
        message: `Only a decrypt-only key can be retired (this key is ${row.status})`,
        details: { status: row.status },
      };
    }
    const retireAfter = new Date((row.deactivatedAt?.getTime() ?? now.getTime()) + this.retireGraceMs);
    if (retireAfter > now) {
      return {
        reason: 'RECENTLY_DEACTIVATED',
        message: 'Every replica must stop sealing with this key first: retry after retireAfter',
        details: { retireAfter: retireAfter.toISOString() },
      };
    }
    const purpose = row.purpose as KeyPurpose;
    const references = await keyReferences(
      this.prisma,
      purpose,
      row.keyId,
      keyRingFor(this.env).activeKeyId(purpose),
    );
    if (references.total > 0) {
      return {
        reason: 'KEY_IN_USE',
        message: 'Values or document blobs still depend on this key: rotate (and purge) them first',
        details: { references },
      };
    }
    return null;
  }

  /** POST /v1/admin/keys/:purpose/:keyId/retire */
  async retire(
    auth: AuthContext,
    purpose: KeyPurpose,
    keyId: string,
    proof: RetireManagedKeyInput,
    req: Request,
  ): Promise<ManagedKeyRow> {
    // The rotation job may have moved values since the ring last refreshed: use the latest state.
    await this.managed.refresh();
    const row = await this.prisma.encryptionKey.findUnique({
      where: { purpose_keyId: { purpose, keyId } },
      select: MANAGED_KEY_SELECT,
    });
    if (!row) throw DomainError.notFound('Managed key');
    const blocker = await this.retireBlocker(row);
    if (blocker)
      throw lifecycleConflict(blocker.reason, blocker.message, { purpose, keyId, ...blocker.details });
    const stepUp = await this.requireStepUp(auth, proof, keyId, req);

    // Compare-and-set on the status: nothing moves a key back from DECRYPT_ONLY, and no new value
    // can be sealed with it (it stopped being active more than two refresh periods ago), so the
    // references counted above cannot grow back in the meantime.
    const { count } = await this.prisma.encryptionKey.updateMany({
      where: { id: row.id, status: ManagedKeyStatus.DECRYPT_ONLY },
      data: { status: ManagedKeyStatus.RETIRED, retiredAt: new Date() },
    });
    if (count !== 1) {
      throw lifecycleConflict('NOT_DECRYPT_ONLY', 'The key changed meanwhile: reload and retry', {
        purpose,
        keyId,
      });
    }
    const retired = await this.prisma.encryptionKey.findUniqueOrThrow({
      where: { id: row.id },
      select: MANAGED_KEY_SELECT,
    });
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'keys.retired',
      entityType: 'EncryptionKey',
      entityId: retired.id,
      metadata: {
        purpose,
        keyId,
        kmsProvider: retired.kmsProvider,
        deactivatedAt: retired.deactivatedAt?.toISOString() ?? null,
        ...(stepUp ? { stepUp } : {}),
      },
      ...requestMeta(req),
    });
    await this.managed.refresh();
    return retired;
  }

  // ── KEY_LIFECYCLE job ───────────────────────────────────────────────────────

  /** Promotes the due STAGED key of a purpose, if any (one transaction, under the purpose lock). */
  private async activateDue(purpose: KeyPurpose, now: Date, summary: LifecycleSummary): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockPurpose(tx, purpose);
      const staged = await tx.encryptionKey.findFirst({
        where: {
          purpose,
          status: ManagedKeyStatus.STAGED,
          OR: [{ activateAfter: null }, { activateAfter: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, keyId: true },
      });
      if (!staged) return null;
      // The replica activating a key must hold it: proves the KMS can unwrap it right now.
      if (!this.managed.isLoaded(staged.id)) return { skipped: staged.keyId };
      const previous = await tx.encryptionKey.findFirst({
        where: { purpose, status: ManagedKeyStatus.ACTIVE },
        select: { id: true, keyId: true },
      });
      if (previous) {
        await tx.encryptionKey.update({
          where: { id: previous.id },
          data: { status: ManagedKeyStatus.DECRYPT_ONLY, deactivatedAt: now },
        });
      }
      await tx.encryptionKey.update({
        where: { id: staged.id },
        data: { status: ManagedKeyStatus.ACTIVE, activatedAt: now },
      });
      return { id: staged.id, keyId: staged.keyId, previousKeyId: previous?.keyId ?? null };
    });
    if (!result) return;
    if ('skipped' in result) {
      summary.skipped.push({ purpose, keyId: result.skipped, reason: 'KEY_NOT_LOADED' });
      this.logger.error(`managed key ${purpose}:${result.skipped} is due but not loaded here: not activated`);
      return;
    }
    // Sealing moves from the environment key (or "legacy") to the managed key when there was none.
    const previousKeyId = result.previousKeyId ?? keyRingFor(this.env).activeKeyId(purpose);
    summary.activated.push({ purpose, keyId: result.keyId, previousKeyId });
    await this.audit.log({
      actorUserId: null,
      action: 'keys.activated',
      entityType: 'EncryptionKey',
      entityId: result.id,
      metadata: { purpose, keyId: result.keyId, previousKeyId },
    });
  }

  /** Stages a new key when the active managed key is older than KEY_ROTATION_INTERVAL_DAYS. */
  private async scheduleRotation(purpose: KeyPurpose, now: Date, summary: LifecycleSummary): Promise<void> {
    const days = this.env.KEY_ROTATION_INTERVAL_DAYS;
    if (days <= 0) return;
    const active = await this.prisma.encryptionKey.findFirst({
      where: { purpose, status: ManagedKeyStatus.ACTIVE },
      select: { keyId: true, activatedAt: true, createdAt: true },
    });
    // Scheduled rotation applies to purposes already under managed keys (first key: generate).
    if (!active) return;
    const since = active.activatedAt ?? active.createdAt;
    if (now.getTime() - since.getTime() < days * DAY_MS) return;
    if (await this.stagedKey(purpose)) return;
    try {
      const row = await this.stage(purpose, { userId: null, trigger: 'scheduled' }, null);
      summary.staged.push({
        purpose,
        keyId: row.keyId,
        activateAfter: row.activateAfter?.toISOString() ?? now.toISOString(),
        reason: 'SCHEDULED',
      });
      await this.audit.log({
        actorUserId: null,
        action: 'keys.rotation_scheduled',
        entityType: 'EncryptionKey',
        entityId: row.id,
        metadata: {
          purpose,
          keyId: row.keyId,
          replaces: active.keyId,
          activeSince: since.toISOString(),
          intervalDays: days,
        },
      });
    } catch (err) {
      const reason =
        err instanceof DomainError && err.code === ErrorCode.KEY_LIFECYCLE_CONFLICT
          ? String((err.details as { reason?: unknown }).reason)
          : kmsFailureReason(err);
      summary.skipped.push({ purpose, reason });
      this.logger.error(`scheduled rotation of ${purpose} not staged: ${reason}`);
    }
  }

  /** Re-encrypts with the newly active keys right away (the scheduler would also get there). */
  private async startRotation(summary: LifecycleSummary): Promise<void> {
    const purposes = [...new Set(summary.activated.map((a) => a.purpose))];
    const trigger = purposes.length === 1 ? `key_lifecycle:purpose=${purposes[0]}` : 'key_lifecycle';
    try {
      const run = await this.maintenance.run(KEY_ROTATION_JOB, trigger);
      summary.rotation = { runId: run.id, status: run.status };
    } catch (err) {
      const code = err instanceof DomainError ? String(err.code) : 'ERROR';
      summary.rotation = { status: 'NOT_STARTED', reason: code };
    }
  }

  /** KEY_LIFECYCLE handler (scheduler, jobs console). */
  async run(ctx: JobContext): Promise<JobResult> {
    const summary: LifecycleSummary = {
      kmsProvider: this.managed.provider?.name ?? 'none',
      activated: [],
      staged: [],
      skipped: [],
      rotation: null,
    };
    if (!this.managed.provider) return { summary: { ...summary } };
    await this.managed.refresh();
    const now = new Date();
    for (const purpose of KEY_PURPOSES) {
      if (ctx.signal?.aborted) break;
      await this.activateDue(purpose, now, summary);
    }
    if (summary.activated.length > 0) await this.managed.refresh();
    for (const purpose of KEY_PURPOSES) {
      if (ctx.signal?.aborted) break;
      await this.scheduleRotation(purpose, now, summary);
    }
    if (summary.activated.length > 0 && !ctx.signal?.aborted) await this.startRotation(summary);
    if (summary.activated.length || summary.staged.length || summary.skipped.length) {
      this.logger.log(
        `key lifecycle: activated=${summary.activated.length} staged=${summary.staged.length} skipped=${summary.skipped.length}`,
      );
    }
    return { summary: { ...summary } };
  }
}
