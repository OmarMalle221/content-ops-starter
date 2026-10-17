import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Request } from 'express';
import type { PrismaTransactionClient } from '@dfn/database';
import { ErrorCode, RECOVERY_CODE_COUNT, normalizeRecoveryCode } from '@dfn/shared';
import { hmacHex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** One recovery code: 10 base32 characters (50 bits) in the canonical XXXX-XXXX-XX layout. */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) raw += BASE32[randomInt(32)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
}

/** Prefix of hashes keyed with MFA_RECOVERY_SECRET (unprefixed hashes are keyed with SESSION_SECRET). */
export const RECOVERY_HASH_V2_PREFIX = 'r2:';

/**
 * MFA recovery codes: generated in batches of 10 when MFA is enabled (or regenerated), shown
 * once, stored only as keyed hashes (HMAC-SHA-256 bound to the user), and single use —
 * consumption is an atomic `UPDATE … WHERE usedAt IS NULL`.
 *
 * Hash key (ADR-0014): with MFA_RECOVERY_SECRET set, new hashes are `r2:` + HMAC(MFA_RECOVERY_SECRET)
 * — rotating SESSION_SECRET (which only signs sessions) then no longer invalidates them. Without
 * it, and for codes created before it was set, the historical unprefixed HMAC(SESSION_SECRET) is
 * used. Verification tries the MFA_RECOVERY_SECRET form first, then the SESSION_SECRET form, in a
 * single compare-and-burn statement.
 */
@Injectable()
export class RecoveryCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Historical form: HMAC keyed with SESSION_SECRET, no prefix. */
  private hashV1(userId: string, canonicalCode: string): string {
    return hmacHex(this.env.SESSION_SECRET, `dfn:mfa-recovery:v1:${userId}:${canonicalCode}`);
  }

  /** Form used for new codes once MFA_RECOVERY_SECRET is set (null otherwise). */
  private hashV2(userId: string, canonicalCode: string): string | null {
    const secret = this.env.MFA_RECOVERY_SECRET;
    if (!secret) return null;
    return `${RECOVERY_HASH_V2_PREFIX}${hmacHex(secret, `dfn:mfa-recovery:v2:${userId}:${canonicalCode}`)}`;
  }

  /** Hash stored for a new code. */
  private hash(userId: string, canonicalCode: string): string {
    return this.hashV2(userId, canonicalCode) ?? this.hashV1(userId, canonicalCode);
  }

  /** Every stored form a typed code may match, preferred secret first. */
  private candidates(userId: string, canonicalCode: string): string[] {
    const v2 = this.hashV2(userId, canonicalCode);
    const v1 = this.hashV1(userId, canonicalCode);
    return v2 ? [v2, v1] : [v1];
  }

  /** Replaces every code of the user with a fresh batch; returns the plaintext codes (once). */
  async replaceAll(userId: string, db: PrismaTransactionClient | PrismaService = this.prisma) {
    const codes = new Set<string>();
    while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateRecoveryCode());
    const list = [...codes];
    await db.mfaRecoveryCode.deleteMany({ where: { userId } });
    await db.mfaRecoveryCode.createMany({
      data: list.map((code) => ({ userId, codeHash: this.hash(userId, code) })),
    });
    return list;
  }

  async deleteAll(userId: string, db: PrismaTransactionClient | PrismaService = this.prisma) {
    await db.mfaRecoveryCode.deleteMany({ where: { userId } });
  }

  async remaining(userId: string): Promise<number> {
    return this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  async summary(userId: string) {
    const [remaining, latest] = await Promise.all([
      this.remaining(userId),
      this.prisma.mfaRecoveryCode.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    return { remaining, total: RECOVERY_CODE_COUNT, generatedAt: latest?.createdAt ?? null };
  }

  /**
   * Burns one recovery code. Unknown, malformed and already used codes are indistinguishable
   * (401 RECOVERY_CODE_INVALID). Audited and notified: a code being used is security-relevant.
   */
  async consume(userId: string, typedCode: string, purpose: string, req?: Request) {
    const canonical = normalizeRecoveryCode(typedCode);
    const invalid = () =>
      new DomainError(
        ErrorCode.RECOVERY_CODE_INVALID,
        'This recovery code is invalid or has already been used',
        HttpStatus.UNAUTHORIZED,
      );
    if (!canonical) throw invalid();
    const burnt = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: { in: this.candidates(userId, canonical) }, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (burnt.count !== 1) throw invalid();
    const remaining = await this.remaining(userId);
    await this.audit.log({
      actorUserId: userId,
      action: 'auth.mfa_recovery_code_used',
      entityType: 'User',
      entityId: userId,
      metadata: { purpose, remaining },
      ...(req ? requestMeta(req) : {}),
    });
    await this.notifications.notify({
      userId,
      type: 'auth.mfa_recovery_code_used',
      title: 'Code de secours utilisé',
      body:
        `Un code de secours a été utilisé pour confirmer une opération sensible sur votre compte. ` +
        `Il vous reste ${remaining} code(s) de secours. Si vous n'êtes pas à l'origine de cette ` +
        `opération, changez votre mot de passe et régénérez vos codes immédiatement.`,
      data: { purpose, remaining },
    });
    return { remaining };
  }
}
