import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import type { Request } from 'express';
import {
  ErrorCode,
  KeyPurpose,
  WebAuthnChallengePurpose,
  isTotpCode,
  type MfaProofInput,
  type StepUpOperation,
  type WebAuthnAssertionInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { KeyRingError, keyRingFor } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AttemptLockout } from './attempt-lockout';
import { RecoveryCodesService } from './recovery-codes.service';
import {
  AssertionFailure,
  WebAuthnService,
  isUuid,
  stepUpOperationKey,
  type StepUpBinding,
} from './webauthn.service';

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
 * - passkey assertions answering a STEP_UP challenge bound to the same user AND session and
 *   issued for the operation and resource the caller binds (phase 7): an assertion obtained for
 *   one action cannot be spent on another (403 STEP_UP_OPERATION_MISMATCH).
 *
 * Wrong codes are counted per account (not per IP, which a client may influence), each attempt
 * BEFORE its code is checked (AttemptLockout), so parallel guesses cannot outrun the count: after
 * MAX_MFA_FAILURES consecutive failures, code attempts are refused (423 ACCOUNT_LOCKED) for
 * MFA_LOCK_MINUTES, the account's pre-MFA sessions are revoked and the owner is notified.
 */
@Injectable()
export class MfaVerifierService {
  private readonly codeAttempts: AttemptLockout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recoveryCodes: RecoveryCodesService,
    private readonly webauthn: WebAuthnService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.codeAttempts = new AttemptLockout(prisma, {
      count: 'mfaFailedCount',
      lockedUntil: 'mfaLockedUntil',
      max: MAX_MFA_FAILURES,
      lockMinutes: MFA_LOCK_MINUTES,
    });
  }

  private lockedError() {
    return new DomainError(
      ErrorCode.ACCOUNT_LOCKED,
      `Too many invalid second-factor codes. Try again in ${MFA_LOCK_MINUTES} minutes.`,
      HttpStatus.LOCKED,
    );
  }

  /**
   * The last allowed code of the window was wrong: the lock its reservation placed stands. Revokes
   * the pre-MFA sessions, audits and notifies — once per lock, only that attempt carries it.
   */
  private async onCodesLocked(userId: string, until: Date, purpose: StepUpOperation, req?: Request) {
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
    const ring = keyRingFor(this.env);
    let secret: string;
    try {
      secret = ring.openString(KeyPurpose.MFA, user.mfaSecretEnc);
    } catch (err) {
      // The secret cannot be opened — sealed with a key the ring no longer has (retired early,
      // legacy decryption switched off: KeyRingError), or not authenticating under the key its id
      // names (a wrong key value under the right id, a corrupted row: DECRYPT_FAILED). The code
      // was not checked, so this is neither a wrong guess nor a 500: the account cannot
      // authenticate until the key is restored (KEY_ROTATION.md §7); assertFreshProof audits it.
      throw new DomainError(
        ErrorCode.KEY_NOT_FOUND,
        'The second factor of this account cannot be checked: its encryption key is not available',
        HttpStatus.SERVICE_UNAVAILABLE,
        {
          purpose: KeyPurpose.MFA,
          keyId: ring.keyIdOfString(user.mfaSecretEnc),
          reason: err instanceof KeyRingError ? 'KEY_NOT_FOUND' : 'DECRYPT_FAILED',
        },
      );
    }
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

  /**
   * Passkey step-up: assertion for a STEP_UP challenge issued to this user, this session and the
   * operation and resource of `binding`. The binding is checked once the challenge is burnt and
   * before the signature: a proof issued for another action — or a challenge from before the
   * binding existed (`operation` null) — is refused without any effect (no counter update), and
   * its challenge cannot be tried again for the right one.
   */
  async verifyPasskeyStepUp(
    auth: Pick<AuthContext, 'userId' | 'sessionId' | 'apiCredential'>,
    assertion: WebAuthnAssertionInput,
    binding: StepUpBinding,
    req?: Request,
  ): Promise<{ credentialId: string }> {
    // The audit trail names the operation the proof is spent on: the bound one, by construction.
    const purpose = binding.operation;
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
    const expected = stepUpOperationKey(binding);
    if (challenge.operation !== expected) {
      await this.audit.log({
        actorUserId: auth.userId,
        action: 'auth.passkey_step_up_failed',
        entityType: 'WebAuthnCredential',
        entityId: credential?.userId === auth.userId ? credential.id : null,
        metadata: { purpose, reason: 'operation_mismatch', expected, issuedFor: challenge.operation },
        ...meta,
      });
      throw new DomainError(
        ErrorCode.STEP_UP_OPERATION_MISMATCH,
        'This passkey confirmation was issued for another operation. Confirm this action again.',
        HttpStatus.FORBIDDEN,
        { operation: binding.operation },
      );
    }
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
   * CHALLENGE_EXPIRED are specific, and codes answer 423 ACCOUNT_LOCKED while locked.
   *
   * `binding` (operation + optional resource id) names the action being authorised. It restricts
   * a passkey assertion to the STEP_UP challenge issued for exactly that action (403
   * STEP_UP_OPERATION_MISMATCH otherwise) and labels the audit trail, lockout notices and the
   * recovery code consumed. Codes carry no binding: a TOTP step and a recovery code are single
   * use whatever they authorise. The binding is mandatory, so no caller can accept any STEP_UP
   * challenge of the session by omission, nor audit one operation while binding another.
   */
  async assertFreshProof(
    auth: Pick<AuthContext, 'userId' | 'sessionId' | 'apiCredential'>,
    proof: MfaProofInput | { mfaCode?: string | null; passkeyAssertion?: WebAuthnAssertionInput | null },
    binding: StepUpBinding,
    failure: ProofFailure,
    req?: Request,
  ): Promise<MfaProofMethod> {
    const purpose = binding.operation;
    const fail = () =>
      new DomainError(
        failure.code ?? ErrorCode.MFA_REQUIRED,
        failure.message,
        failure.status ?? HttpStatus.UNAUTHORIZED,
      );
    if (proof.passkeyAssertion) {
      await this.verifyPasskeyStepUp(auth, proof.passkeyAssertion, binding, req);
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
    // Counted before the code is checked; while locked, no code is checked at all (no oracle).
    const attempt = await this.codeAttempts.reserve(auth.userId);
    if (!attempt) throw this.lockedError();
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
      // A replayed valid code (MFA_CODE_REUSED) or a code that could not be checked at all
      // (KEY_NOT_FOUND) is not a guess: its attempt is given back. A wrong code keeps it; the one
      // that reached the threshold answers 423 instead of its own error.
      const guess = wrongTotp || (err instanceof DomainError && err.code === ErrorCode.RECOVERY_CODE_INVALID);
      if (!guess) {
        await this.codeAttempts.release(attempt);
        if (err instanceof DomainError && err.code === ErrorCode.KEY_NOT_FOUND) {
          // An operational outage, audited once here for every step-up (login, key management,
          // transfers, gates…), never counted against the account.
          await this.audit.log({
            actorUserId: auth.userId,
            action: 'auth.mfa_key_unavailable',
            entityType: 'User',
            entityId: auth.userId,
            metadata: {
              operation: purpose,
              ...(typeof err.details === 'object' && err.details ? err.details : {}),
            },
            ...(req ? requestMeta(req) : {}),
          });
        }
      } else if (attempt.lockedUntil) {
        await this.onCodesLocked(auth.userId, attempt.lockedUntil, purpose, req);
        throw this.lockedError();
      }
      throw err;
    }
    await this.codeAttempts.succeeded(attempt);
    return method;
  }
}
