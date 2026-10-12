import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import type { Request } from 'express';
import {
  ErrorCode,
  KeyPurpose,
  WebAuthnChallengePurpose,
  isTotpCode,
  type MfaProofInput,
  type WebAuthnAssertionInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { openString } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RecoveryCodesService } from './recovery-codes.service';
import { AssertionFailure, WebAuthnService, isUuid } from './webauthn.service';

export type MfaProofMethod = 'totp' | 'recovery_code' | 'passkey';

/** Wrong TOTP / recovery codes tolerated per account before second-factor attempts are locked. */
export const MAX_MFA_FAILURES = 5;
export const MFA_LOCK_MINUTES = 15;

/**
 * TOTP time step (RFC 6238 counter) a code was accepted at, or null when the code is invalid.
 * Uses the platform authenticator settings (step, digits, window) frozen at `epochMs`, so the
 * returned step and the check itself always refer to the same instant.
 */
export function acceptedTotpStep(secret: string, token: string, epochMs: number): bigint | null {
  const otp = authenticator.clone({ epoch: epochMs });
  let delta: number | null;
  try {
    delta = otp.checkDelta(token, secret);
  } catch {
    return null;
  }
  if (typeof delta !== 'number') return null;
  const step = otp.allOptions().step;
  return BigInt(Math.floor(epochMs / 1000 / step) + delta);
}

export interface ProofFailure {
  /** Error code when no proof is supplied or a TOTP code is wrong (MFA_REQUIRED by default). */
  code?: string;
  message: string;
  status?: number;
}

/**
 * The single place where a second factor is checked (ADR-0009):
 * - TOTP codes with anti-replay: the accepted time step is recorded atomically
 *   (`UPDATE "User" … WHERE mfaLastUsedStep IS NULL OR mfaLastUsedStep < step`), so a code is
 *   accepted at most once, even by concurrent requests (401 MFA_CODE_REUSED);
 * - single-use recovery codes (wherever a TOTP code is accepted);
 * - passkey assertions answering a STEP_UP challenge bound to the same user AND session.
 *
 * Wrong codes are counted per account (not per IP, which a client may influence): after
 * MAX_MFA_FAILURES consecutive failures, code attempts are refused (423 ACCOUNT_LOCKED) for
 * MFA_LOCK_MINUTES, the account's pre-MFA sessions are revoked and the owner is notified.
 */
@Injectable()
export class MfaVerifierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recoveryCodes: RecoveryCodesService,
    private readonly webauthn: WebAuthnService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private lockedError() {
    return new DomainError(
      ErrorCode.ACCOUNT_LOCKED,
      `Too many invalid second-factor codes. Try again in ${MFA_LOCK_MINUTES} minutes.`,
      HttpStatus.LOCKED,
    );
  }

  /** Refuses code attempts while the account's second-factor lock is active (no code oracle). */
  async assertCodesNotLocked(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaLockedUntil: true },
    });
    if (user?.mfaLockedUntil && user.mfaLockedUntil > new Date()) throw this.lockedError();
  }

  /**
   * Counts a wrong code. The request that reaches the threshold sets the lock (compare-and-set on
   * the counter, so concurrent failures lock once), revokes the pre-MFA sessions, audits and
   * notifies; it then throws 423 instead of the original error.
   */
  private async recordCodeFailure(userId: string, purpose: string, req?: Request) {
    const counted = await this.prisma.user.update({
      where: { id: userId },
      data: { mfaFailedCount: { increment: 1 } },
      select: { mfaFailedCount: true },
    });
    if (counted.mfaFailedCount < MAX_MFA_FAILURES) return;
    const until = new Date(Date.now() + MFA_LOCK_MINUTES * 60_000);
    const locked = await this.prisma.user.updateMany({
      where: { id: userId, mfaFailedCount: { gte: MAX_MFA_FAILURES } },
      data: { mfaFailedCount: 0, mfaLockedUntil: until },
    });
    if (locked.count === 1) {
      const revoked = await this.prisma.session.updateMany({
        where: { userId, mfaVerified: false, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        actorUserId: userId,
        action: 'auth.mfa_locked',
        entityType: 'User',
        entityId: userId,
        metadata: {
          purpose,
          failures: MAX_MFA_FAILURES,
          lockedUntil: until.toISOString(),
          preMfaSessionsRevoked: revoked.count,
        },
        ...(req ? requestMeta(req) : {}),
      });
      await this.notifications.notify({
        userId,
        type: 'auth.mfa_locked',
        title: 'Second facteur temporairement bloqué',
        body:
          `Plusieurs codes de vérification erronés ont été saisis sur votre compte. Les codes sont ` +
          `refusés pendant ${MFA_LOCK_MINUTES} minutes. Si vous n'êtes pas à l'origine de ces ` +
          `tentatives, votre mot de passe est probablement connu d'un tiers : changez-le immédiatement.`,
        data: { purpose, lockedUntil: until.toISOString() },
      });
    }
    throw this.lockedError();
  }

  /**
   * Verifies a TOTP code for the user. With `consume` (every authentication or step-up use) the
   * accepted step is burnt; enrolment confirmation passes `consume: false` — it proves the
   * authenticator app is configured, it does not authenticate anything (see ADR-0009).
   */
  async verifyTotp(
    userId: string,
    code: string,
    options: { consume: boolean; invalid: () => DomainError },
  ): Promise<{ step: bigint }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecretEnc: true },
    });
    if (!user?.mfaSecretEnc || !isTotpCode(code)) throw options.invalid();
    const secret = openString(this.env, KeyPurpose.MFA, user.mfaSecretEnc);
    const step = acceptedTotpStep(secret, code.trim(), Date.now());
    if (step === null) throw options.invalid();
    if (options.consume) {
      const burnt = await this.prisma.user.updateMany({
        where: { id: userId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
        data: { mfaLastUsedStep: step },
      });
      if (burnt.count !== 1) {
        throw new DomainError(
          ErrorCode.MFA_CODE_REUSED,
          'This code has already been used. Wait for the next code of your authenticator app.',
          HttpStatus.UNAUTHORIZED,
        );
      }
    }
    return { step };
  }

  /** Passkey step-up: assertion for a STEP_UP challenge issued to this user and this session. */
  async verifyPasskeyStepUp(
    auth: Pick<AuthContext, 'userId' | 'sessionId' | 'apiCredential'>,
    assertion: WebAuthnAssertionInput,
    purpose: string,
    req?: Request,
  ): Promise<{ credentialId: string }> {
    // Partner API keys have no browser session (sessionId "api:…"): no passkey ceremony there.
    if (auth.apiCredential || !isUuid(auth.sessionId)) throw new AssertionFailure('credential_unknown');
    const challenge = await this.webauthn.consumeChallenge(
      assertion.response.clientDataJSON,
      WebAuthnChallengePurpose.STEP_UP,
      { userId: auth.userId, sessionId: auth.sessionId },
    );
    const credential = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId: assertion.id.replace(/=+$/, '') },
    });
    const meta = req ? requestMeta(req) : {};
    try {
      if (!credential || credential.userId !== auth.userId) throw new AssertionFailure('credential_unknown');
      await this.webauthn.verifyAssertion(assertion, challenge, credential);
    } catch (err) {
      if (err instanceof AssertionFailure) {
        await this.audit.log({
          actorUserId: auth.userId,
          action: 'auth.passkey_step_up_failed',
          entityType: 'WebAuthnCredential',
          entityId: credential?.userId === auth.userId ? credential.id : null,
          metadata: { purpose, reason: err.reason },
          ...meta,
        });
      }
      throw err;
    }
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'auth.passkey_step_up',
      entityType: 'WebAuthnCredential',
      entityId: credential.id,
      metadata: { purpose },
      ...meta,
    });
    return { credentialId: credential.id };
  }

  /**
   * Requires a fresh second factor for a sensitive operation: `passkeyAssertion` when present,
   * otherwise `mfaCode` (6 digits → TOTP with anti-replay, anything else → recovery code).
   * Throws `failure` (401 MFA_REQUIRED by default) when no proof is given or the TOTP code is
   * wrong; MFA_CODE_REUSED, RECOVERY_CODE_INVALID, PASSKEY_VERIFICATION_FAILED and
   * CHALLENGE_EXPIRED are specific.
   */
  async assertFreshProof(
    auth: Pick<AuthContext, 'userId' | 'sessionId' | 'apiCredential'>,
    proof: MfaProofInput | { mfaCode?: string | null; passkeyAssertion?: WebAuthnAssertionInput | null },
    purpose: string,
    failure: ProofFailure,
    req?: Request,
  ): Promise<MfaProofMethod> {
    const fail = () =>
      new DomainError(
        failure.code ?? ErrorCode.MFA_REQUIRED,
        failure.message,
        failure.status ?? HttpStatus.UNAUTHORIZED,
      );
    if (proof.passkeyAssertion) {
      await this.verifyPasskeyStepUp(auth, proof.passkeyAssertion, purpose, req);
      return 'passkey';
    }
    const code = proof.mfaCode?.trim();
    if (!code) throw fail();
    // Codes are second factors only once MFA is enabled (a pending setup secret proves nothing).
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: { mfaEnabled: true },
    });
    if (!user?.mfaEnabled) throw fail();
    await this.assertCodesNotLocked(auth.userId);
    let wrongTotp = false;
    let method: MfaProofMethod;
    try {
      if (isTotpCode(code)) {
        const invalid = () => {
          wrongTotp = true;
          return fail();
        };
        await this.verifyTotp(auth.userId, code, { consume: true, invalid });
        method = 'totp';
      } else {
        await this.recoveryCodes.consume(auth.userId, code, purpose, req);
        method = 'recovery_code';
      }
    } catch (err) {
      // A replayed valid code (MFA_CODE_REUSED) is not a guess; wrong codes are.
      const guess = wrongTotp || (err instanceof DomainError && err.code === ErrorCode.RECOVERY_CODE_INVALID);
      if (guess) await this.recordCodeFailure(auth.userId, purpose, req);
      throw err;
    }
    await this.prisma.user.updateMany({
      where: { id: auth.userId, mfaFailedCount: { gt: 0 } },
      data: { mfaFailedCount: 0 },
    });
    return method;
  }
}
