import { HttpStatus, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request } from 'express';
import type { WebAuthnCredential } from '@dfn/database';
import {
  ErrorCode,
  WebAuthnChallengePurpose,
  type PasskeyRegistrationOptionsInput,
  type PasskeyRegistrationVerifyInput,
  type PasskeyRevokeInput,
  type WebAuthnAssertionInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { MfaVerifierService } from './mfa-verifier.service';
import { SessionService } from './session.service';
import { AssertionFailure, WebAuthnService, isUuid } from './webauthn.service';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** Upper bound of active passkeys per account (keeps excludeCredentials and listings small). */
const MAX_PASSKEYS_PER_USER = 20;

export function toPasskeyDto(c: WebAuthnCredential) {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    deviceType: c.deviceType,
    backedUp: c.backedUp,
    transports: c.transports,
    aaguid: c.aaguid,
    status: c.revokedAt ? ('REVOKED' as const) : ('ACTIVE' as const),
    revokedAt: c.revokedAt,
    nextActions: c.revokedAt ? [] : (['RENAME', 'REVOKE'] as const),
  };
}
export type PasskeyDto = ReturnType<typeof toPasskeyDto>;

function passkeyNotFound() {
  return new DomainError(ErrorCode.PASSKEY_NOT_FOUND, 'Passkey not found', HttpStatus.NOT_FOUND);
}

/** Refuses partner API keys: passkey ceremonies belong to a first-party browser session. */
function assertBrowserSession(auth: AuthContext) {
  if (auth.apiCredential || !isUuid(auth.sessionId)) {
    throw DomainError.forbidden('Passkeys are managed from a signed-in browser session only');
  }
}

/**
 * Passkeys (WebAuthn): registration for an MFA-verified session, listing / renaming /
 * revocation, passwordless login (discoverable credentials) and the STEP_UP challenge used to
 * replace a TOTP code by an assertion (see MfaVerifierService).
 */
@Injectable()
export class PasskeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webauthn: WebAuthnService,
    private readonly verifier: MfaVerifierService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
  ) {}

  private activeFor(userId: string) {
    return this.prisma.webAuthnCredential.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async list(auth: AuthContext) {
    const items = await this.activeFor(auth.userId);
    return { items: items.map(toPasskeyDto) };
  }

  // ───────────────────────────── Registration ─────────────────────────────

  /**
   * Registration challenge, issued only after a fresh proof (ADR-0009): second factor when MFA is
   * enabled, otherwise the current password or an assertion of an existing passkey. The proof is
   * checked here, before the ceremony; the challenge is then bound to this user and session.
   */
  async registrationOptions(auth: AuthContext, proof: PasskeyRegistrationOptionsInput, req: Request) {
    assertBrowserSession(auth);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const existing = await this.activeFor(user.id);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw DomainError.conflict(`At most ${MAX_PASSKEYS_PER_USER} passkeys per account`);
    }
    if (user.mfaEnabled || proof.passkeyAssertion) {
      await this.verifier.assertFreshProof(
        auth,
        proof,
        'passkey.register',
        {
          code: ErrorCode.STEP_UP_REQUIRED,
          message: 'A fresh second factor (code or passkey) is required to add a passkey',
        },
        req,
      );
    } else {
      const ok = proof.currentPassword
        ? await argon2.verify(user.passwordHash, proof.currentPassword).catch(() => false)
        : false;
      if (!ok) {
        if (proof.currentPassword) {
          await this.audit.log({
            actorUserId: user.id,
            action: 'auth.passkey_registration_refused',
            entityType: 'User',
            entityId: user.id,
            metadata: { reason: 'password_invalid' },
            ...requestMeta(req),
          });
        }
        throw new DomainError(
          ErrorCode.STEP_UP_REQUIRED,
          'Confirm your current password to add a passkey',
          HttpStatus.UNAUTHORIZED,
        );
      }
    }
    return this.webauthn.registrationOptions(user, auth.sessionId, existing);
  }

  async registrationVerify(auth: AuthContext, input: PasskeyRegistrationVerifyInput, req: Request) {
    assertBrowserSession(auth);
    const challenge = await this.webauthn.consumeChallenge(
      input.response.response.clientDataJSON,
      WebAuthnChallengePurpose.REGISTRATION,
      { userId: auth.userId, sessionId: auth.sessionId },
    );
    const info = await this.webauthn.verifyRegistration(input.response, challenge);
    const credentialId = info.credential.id;
    const taken = await this.prisma.webAuthnCredential.findUnique({ where: { credentialId } });
    if (taken) throw DomainError.conflict('This passkey is already registered');
    const transports = (input.response.response.transports ?? info.credential.transports ?? []).slice(0, 10);
    const meta = requestMeta(req);
    const created = await this.prisma.$transaction(async (db) => {
      // The cap is re-checked under a lock of the user row: parallel ceremonies started while the
      // account had MAX-1 passkeys must not all succeed.
      await db.$queryRaw`SELECT id FROM "User" WHERE id = ${auth.userId}::uuid FOR UPDATE`;
      const active = await db.webAuthnCredential.count({ where: { userId: auth.userId, revokedAt: null } });
      if (active >= MAX_PASSKEYS_PER_USER) {
        throw DomainError.conflict(`At most ${MAX_PASSKEYS_PER_USER} passkeys per account`);
      }
      const row = await db.webAuthnCredential.create({
        data: {
          userId: auth.userId,
          credentialId,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: BigInt(info.credential.counter),
          transports,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          aaguid: info.aaguid,
          name: input.name,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'auth.passkey_registered',
          entityType: 'WebAuthnCredential',
          entityId: row.id,
          metadata: {
            name: row.name,
            deviceType: row.deviceType,
            backedUp: row.backedUp,
            aaguid: row.aaguid,
            userVerified: info.userVerified,
          },
          ...meta,
        },
        db,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'auth.passkey_registered',
          title: 'Nouvelle clé d’accès',
          body:
            `Une nouvelle clé d’accès « ${row.name} » a été ajoutée à votre compte. Si vous n’êtes ` +
            `pas à l’origine de cet ajout, révoquez-la depuis vos paramètres et changez votre mot de ` +
            `passe immédiatement.`,
          data: { passkeyId: row.id },
        },
        db,
      );
      return row;
    });
    return toPasskeyDto(created);
  }

  // ───────────────────────────── Management ─────────────────────────────

  /** Own active passkey or 404 (another user's passkey is indistinguishable from a missing one). */
  private async ownActive(auth: AuthContext, id: string) {
    const credential = await this.prisma.webAuthnCredential.findUnique({ where: { id } });
    if (!credential || credential.userId !== auth.userId || credential.revokedAt) throw passkeyNotFound();
    return credential;
  }

  async rename(auth: AuthContext, id: string, name: string, req: Request) {
    const credential = await this.ownActive(auth, id);
    const updated = await this.prisma.webAuthnCredential.update({
      where: { id: credential.id },
      data: { name },
    });
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'auth.passkey_renamed',
      entityType: 'WebAuthnCredential',
      entityId: credential.id,
      metadata: { from: credential.name, to: name },
      ...requestMeta(req),
    });
    return toPasskeyDto(updated);
  }

  /**
   * Revocation (soft: revokedAt). When the user has MFA enabled a fresh proof is required — TOTP
   * code, recovery code or a passkey assertion — so a hijacked session cannot strip a factor.
   */
  async revoke(auth: AuthContext, id: string, proof: PasskeyRevokeInput, req: Request) {
    const credential = await this.ownActive(auth, id);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { mfaEnabled: true },
    });
    const method = user.mfaEnabled
      ? await this.verifier.assertFreshProof(
          auth,
          proof,
          'passkey.revoke',
          {
            code: ErrorCode.STEP_UP_REQUIRED,
            message: 'A fresh second factor (code or passkey) is required to revoke a passkey',
          },
          req,
        )
      : null;
    const now = new Date();
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      const res = await db.webAuthnCredential.updateMany({
        where: { id: credential.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (res.count !== 1) throw passkeyNotFound();
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'auth.passkey_revoked',
          entityType: 'WebAuthnCredential',
          entityId: credential.id,
          metadata: { name: credential.name, stepUp: method },
          ...meta,
        },
        db,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'auth.passkey_revoked',
          title: 'Clé d’accès révoquée',
          body:
            `La clé d’accès « ${credential.name} » a été révoquée : elle ne permet plus de se ` +
            `connecter ni de confirmer une opération. Si vous n’êtes pas à l’origine de cette ` +
            `révocation, changez votre mot de passe immédiatement.`,
          data: { passkeyId: credential.id },
        },
        db,
      );
    });
    return { revoked: true, id: credential.id };
  }

  // ───────────────────────────── Passwordless login ─────────────────────────────

  /**
   * Same response for every caller: discoverable credentials, empty allowCredentials, nothing
   * looked up — neither the existence of an account nor of its passkeys can be inferred.
   */
  async authenticationOptions() {
    return this.webauthn.authenticationOptions(WebAuthnChallengePurpose.AUTHENTICATION, {
      userId: null,
      sessionId: null,
    });
  }

  private loginRefused() {
    return new DomainError(
      ErrorCode.PASSKEY_VERIFICATION_FAILED,
      'Passkey sign-in failed',
      HttpStatus.UNAUTHORIZED,
    );
  }

  /**
   * Passwordless login. Mirrors the password login (AuthService.login): lock and status checks,
   * failed attempts counted towards the 15-minute lock with the same audit + risk evaluation,
   * then a session flagged mfaVerified — a user-verifying passkey is a phishing-resistant
   * multi-factor credential on its own.
   */
  async authenticationVerify(response: WebAuthnAssertionInput, req: Request) {
    const meta = requestMeta(req);
    const challenge = await this.webauthn.consumeChallenge(
      response.response.clientDataJSON,
      WebAuthnChallengePurpose.AUTHENTICATION,
      { userId: null, sessionId: null },
    );
    const credential = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId: response.id.replace(/=+$/, '') },
      include: { user: true },
    });
    if (!credential) throw this.loginRefused();
    const user = credential.user;
    if (user.deletedAt || user.anonymizedAt) throw this.loginRefused();
    if (credential.revokedAt) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'auth.login_failed',
        entityType: 'User',
        entityId: user.id,
        metadata: { method: 'passkey', reason: 'credential_revoked', passkeyId: credential.id },
        ...meta,
      });
      throw this.loginRefused();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError(
        ErrorCode.ACCOUNT_LOCKED,
        'Account temporarily locked. Try again later.',
        HttpStatus.LOCKED,
      );
    }
    if (user.status !== 'ACTIVE') {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Account is not active', HttpStatus.FORBIDDEN);
    }
    try {
      await this.webauthn.verifyAssertion(response, challenge, credential);
    } catch (err) {
      if (!(err instanceof AssertionFailure)) throw err;
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await this.audit.log({
        actorUserId: user.id,
        action: 'auth.login_failed',
        entityType: 'User',
        entityId: user.id,
        metadata: { method: 'passkey', reason: err.reason, passkeyId: credential.id },
        ...meta,
      });
      await this.risk.evaluateAndRecord({
        event: 'auth.login_failed',
        userId: user.id,
        failedLoginsLast15m: failed,
      });
      if (err.reason === 'counter_regression') {
        // A valid signature with a counter that went backwards: the authenticator was probably
        // cloned. The owner is told so they can revoke it.
        await this.notifications.notify({
          userId: user.id,
          type: 'auth.passkey_counter_regression',
          title: 'Clé d’accès suspecte',
          body:
            `Une connexion avec la clé d’accès « ${credential.name} » a été refusée : son compteur ` +
            `de signatures a reculé, ce qui peut indiquer une copie de la clé. Révoquez-la depuis ` +
            `vos paramètres si vous ne reconnaissez pas cette tentative.`,
          data: { passkeyId: credential.id },
        });
      }
      if (lock) {
        throw new DomainError(
          ErrorCode.ACCOUNT_LOCKED,
          'Too many attempts. Account locked for 15 minutes.',
          HttpStatus.LOCKED,
        );
      }
      throw this.loginRefused();
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const { token, session } = await this.sessions.create(user.id, req, { mfaVerified: true });
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      metadata: { method: 'passkey', passkeyId: credential.id, sessionId: session.id },
      ...meta,
    });
    return { user, token };
  }

  // ───────────────────────────── Step-up ─────────────────────────────

  /**
   * STEP_UP challenge for the user's active passkeys, bound to this user and this session. Also
   * allowed before the login MFA step (the assertion then completes it).
   */
  async stepUpOptions(auth: AuthContext) {
    assertBrowserSession(auth);
    const credentials = await this.activeFor(auth.userId);
    if (!credentials.length) throw passkeyNotFound();
    return this.webauthn.authenticationOptions(
      WebAuthnChallengePurpose.STEP_UP,
      { userId: auth.userId, sessionId: auth.sessionId },
      credentials,
    );
  }
}
