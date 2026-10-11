import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AuthChallenge, WebAuthnCredential } from '@dfn/database';
import {
  ErrorCode,
  WebAuthnChallengePurpose,
  type WebAuthnAssertionInput,
  type WebAuthnRegistrationResponseInput,
} from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';

/** A challenge is single use and lives 5 minutes (also the browser-side ceremony timeout). */
export const CHALLENGE_TTL_MS = 5 * 60_000;

export type ChallengeBinding = { userId: string | null; sessionId: string | null };

export type AssertionFailureReason =
  | 'credential_unknown'
  | 'credential_revoked'
  | 'user_handle_mismatch'
  | 'signature_invalid'
  | 'counter_regression'
  | 'concurrent_use';

/** Thrown by `verifyAssertion` so callers can account for the failure (lockout, audit, risk). */
export class AssertionFailure extends DomainError {
  constructor(
    public readonly reason: AssertionFailureReason,
    status: number = HttpStatus.UNAUTHORIZED,
  ) {
    super(ErrorCode.PASSKEY_VERIFICATION_FAILED, 'Passkey verification failed', status);
  }
}

export function challengeExpired() {
  return new DomainError(
    ErrorCode.CHALLENGE_EXPIRED,
    'The passkey challenge is unknown, expired or already used. Start again.',
    HttpStatus.UNAUTHORIZED,
  );
}

/** WebAuthn user handle: the account UUID as UTF-8 bytes (never an e-mail or other PII). */
export function userHandleBytes(userId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(userId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Low-level WebAuthn ceremonies on top of @simplewebauthn/server v14: relying-party settings,
 * challenge issuance and atomic single-use consumption (AuthChallenge), registration and
 * assertion verification with a compare-and-set signature counter update.
 */
@Injectable()
export class WebAuthnService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get rpID(): string {
    return this.env.WEBAUTHN_RP_ID;
  }

  get expectedOrigins(): string[] {
    return this.env.WEBAUTHN_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  // ───────────────────────────── Challenges ─────────────────────────────

  private async storeChallenge(
    purpose: WebAuthnChallengePurpose,
    challenge: string,
    binding: ChallengeBinding,
  ) {
    await this.prisma.authChallenge.create({
      data: {
        purpose,
        challenge,
        userId: binding.userId,
        sessionId: binding.sessionId,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
  }

  /**
   * Finds the challenge carried by `clientDataJSON` and burns it atomically, BEFORE any signature
   * check: a challenge can never be tried twice, whatever the outcome. Unknown challenges, wrong
   * purpose, wrong user or session binding, expiry and reuse all produce the same error.
   */
  async consumeChallenge(
    clientDataJSON: string,
    purpose: WebAuthnChallengePurpose,
    binding: ChallengeBinding,
  ): Promise<AuthChallenge> {
    let challenge: unknown;
    try {
      challenge = decodeClientDataJSON(clientDataJSON).challenge;
    } catch {
      throw challengeExpired();
    }
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > 512) {
      throw challengeExpired();
    }
    const row = await this.prisma.authChallenge.findUnique({ where: { challenge } });
    if (
      !row ||
      row.purpose !== purpose ||
      row.userId !== binding.userId ||
      row.sessionId !== binding.sessionId
    ) {
      throw challengeExpired();
    }
    const now = new Date();
    const burnt = await this.prisma.authChallenge.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (burnt.count !== 1) throw challengeExpired();
    return row;
  }

  // ───────────────────────────── Registration ─────────────────────────────

  async registrationOptions(
    user: { id: string; email: string; firstName: string; lastName: string },
    sessionId: string,
    existing: Array<Pick<WebAuthnCredential, 'credentialId' | 'transports'>>,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: this.env.WEBAUTHN_RP_NAME,
      rpID: this.rpID,
      userName: user.email,
      userID: userHandleBytes(user.id),
      userDisplayName: `${user.firstName} ${user.lastName}`.trim(),
      timeout: CHALLENGE_TTL_MS,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await this.storeChallenge(WebAuthnChallengePurpose.REGISTRATION, options.challenge, {
      userId: user.id,
      sessionId,
    });
    return options;
  }

  /** Verifies an attestation against a challenge already consumed by the caller. */
  async verifyRegistration(response: WebAuthnRegistrationResponseInput, challenge: AuthChallenge) {
    try {
      const result = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        requireUserPresence: true,
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error('not verified');
      return result.registrationInfo;
    } catch {
      throw new DomainError(
        ErrorCode.PASSKEY_VERIFICATION_FAILED,
        'The passkey could not be verified (origin, relying party, challenge or user verification)',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ───────────────────────────── Authentication ─────────────────────────────

  /**
   * Options for an assertion. `allowCredentials` is empty for passwordless login (discoverable
   * credentials: the response never depends on who asks) and lists the user's passkeys for a
   * step-up of an authenticated session.
   */
  async authenticationOptions(
    purpose: typeof WebAuthnChallengePurpose.AUTHENTICATION | typeof WebAuthnChallengePurpose.STEP_UP,
    binding: ChallengeBinding,
    allowCredentials: Array<Pick<WebAuthnCredential, 'credentialId' | 'transports'>> = [],
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: allowCredentials.map((c) => ({ id: c.credentialId, transports: c.transports })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });
    await this.storeChallenge(purpose, options.challenge, binding);
    return options;
  }

  /**
   * Verifies an assertion (signature, origin, RP ID, user presence + verification) for a stored
   * credential, then enforces the signature counter and records it with a compare-and-set update.
   *
   * The library is given counter 0 so that it always checks the signature; the counter rule is
   * applied right after, on a response whose signature is known to be valid — so a regression
   * is a reliable "cloned authenticator" signal rather than noise from forged requests. Rule
   * (WebAuthn §6.1.1): when either the stored or the reported counter is non-zero, the reported
   * one must be strictly greater.
   */
  async verifyAssertion(
    response: WebAuthnAssertionInput,
    challenge: AuthChallenge,
    credential: WebAuthnCredential,
  ): Promise<{ newCounter: bigint }> {
    if (credential.revokedAt) throw new AssertionFailure('credential_revoked');
    if (response.response.userHandle) {
      const expected = isoBase64URL.fromBuffer(userHandleBytes(credential.userId));
      if (response.response.userHandle.replace(/=+$/, '') !== expected) {
        throw new AssertionFailure('user_handle_mismatch');
      }
    }
    let info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>['authenticationInfo'];
    try {
      const result = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: 0,
          transports: credential.transports,
        },
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error('not verified');
      info = result.authenticationInfo;
    } catch {
      throw new AssertionFailure('signature_invalid');
    }
    const stored = credential.counter;
    const reported = BigInt(info.newCounter);
    if ((reported > 0n || stored > 0n) && reported <= stored) {
      throw new AssertionFailure('counter_regression');
    }
    const updated = await this.prisma.webAuthnCredential.updateMany({
      where: { id: credential.id, counter: stored, revokedAt: null },
      data: {
        counter: reported,
        lastUsedAt: new Date(),
        backedUp: info.credentialBackedUp,
        deviceType: info.credentialDeviceType,
      },
    });
    if (updated.count !== 1) throw new AssertionFailure('concurrent_use');
    return { newCounter: reported };
  }
}
