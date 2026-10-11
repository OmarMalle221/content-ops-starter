import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { authenticator } from 'otplib';
import type { Prisma, PrismaTransactionClient } from '@dfn/database';
import {
  DEFAULT_SECURITY_PREFERENCES,
  ErrorCode,
  securityPreferencesSchema,
  type SecurityPreferencesInput,
  KeyPurpose,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { openString } from '../../common/keyring';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface SecurityPreferences {
  requireMfaForTransfers: boolean;
  transferAlerts: boolean;
  /** Self-imposed daily transfer limit as a decimal string (per currency), or null when unset. */
  dailyTransferLimit: string | null;
}

/** Tolerant normalisation of the stored JSON: unknown or malformed values fall back to the defaults. */
export function normalizeSecurityPreferences(raw: unknown): SecurityPreferences {
  const parsed = securityPreferencesSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : DEFAULT_SECURITY_PREFERENCES;
  return {
    requireMfaForTransfers: value.requireMfaForTransfers,
    transferAlerts: value.transferAlerts,
    dailyTransferLimit: normalizeLimit(value.dailyTransferLimit ?? null),
  };
}

function normalizeLimit(limit: string | null): string | null {
  if (limit === null) return null;
  const [whole, frac = ''] = limit.trim().replace(',', '.').split('.');
  return `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

/** Normalised limits always carry two decimals, so their digits compare as integers. */
function limitToMinor(limit: string): bigint {
  return BigInt(limit.replace('.', ''));
}

/**
 * True when `next` relaxes a protection `before` had: the transfer step-up switched off, or the
 * self-imposed daily limit raised or removed. Tightening never counts.
 */
export function lowersSecurity(before: SecurityPreferences, next: SecurityPreferences): boolean {
  if (before.requireMfaForTransfers && !next.requireMfaForTransfers) return true;
  if (before.dailyTransferLimit === null) return false;
  if (next.dailyTransferLimit === null) return true;
  return limitToMinor(next.dailyTransferLimit) > limitToMinor(before.dailyTransferLimit);
}

@Injectable()
export class SecurityPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Effective preferences of a user (defaults applied). Used by the transfer authorisation flow. */
  async getForUser(
    userId: string,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<SecurityPreferences> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { securityPreferences: true } });
    return normalizeSecurityPreferences(user?.securityPreferences ?? null);
  }

  async get(auth: AuthContext) {
    const preferences = await this.getForUser(auth.userId);
    return { ...preferences, defaults: DEFAULT_SECURITY_PREFERENCES };
  }

  async update(auth: AuthContext, input: SecurityPreferencesInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { mfaEnabled: true, mfaSecretEnc: true, securityPreferences: true },
    });
    const before = normalizeSecurityPreferences(user.securityPreferences ?? null);
    const next = normalizeSecurityPreferences(input);
    // A hijacked session must not be able to switch the transfer step-up off or lift the daily
    // limit: lowering a protection is itself a step-up operation once MFA is enabled.
    const mfaVerified = user.mfaEnabled && lowersSecurity(before, next);
    if (mfaVerified) this.assertMfaCode(user.mfaSecretEnc, input.mfaCode);
    const changed = (Object.keys(next) as Array<keyof SecurityPreferences>).filter(
      (k) => before[k] !== next[k],
    );
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.user.update({
        where: { id: auth.userId },
        data: { securityPreferences: next as unknown as Prisma.InputJsonValue },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'user.security_preferences_updated',
          entityType: 'User',
          entityId: auth.userId,
          metadata: {
            changed,
            requireMfaForTransfers: next.requireMfaForTransfers,
            transferAlerts: next.transferAlerts,
            dailyTransferLimit: next.dailyTransferLimit,
            mfaVerified,
          },
          ...meta,
        },
        db,
      );
    });
    if (changed.length) {
      await this.notifications.notify({
        userId: auth.userId,
        type: 'user.security_preferences_updated',
        title: 'Préférences de sécurité mises à jour',
        body: `Vos préférences de sécurité pour les transferts ont été modifiées (${changed.join(', ')}). Si vous n'êtes pas à l'origine de ce changement, changez votre mot de passe immédiatement.`,
        data: { changed },
      });
    }
    return { ...next, defaults: DEFAULT_SECURITY_PREFERENCES };
  }

  /** Same verification as the transfer authorisation step-up (TransfersService.assertMfa). */
  private assertMfaCode(mfaSecretEnc: string | null, mfaCode: string | undefined) {
    const secret = mfaSecretEnc ? openString(this.env, KeyPurpose.MFA, mfaSecretEnc) : null;
    if (!mfaCode || !secret || !authenticator.verify({ token: mfaCode, secret })) {
      throw new DomainError(
        ErrorCode.MFA_REQUIRED,
        'A valid two-factor code is required to lower your security preferences',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
