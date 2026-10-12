import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import type { Request } from 'express';
import {
  ErrorCode,
  type LoginInput,
  type MfaDisableInput,
  type MfaEnableInput,
  type MfaVerifyInput,
  type RecoveryCodesRegenerateInput,
  type RegisterInput,
  KeyPurpose,
} from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { sha256Hex } from '../../common/crypto';
import { sealString } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { SessionService } from './session.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { AuthContext } from '../../common/auth-context';
import { MfaVerifierService } from './mfa-verifier.service';
import { RecoveryCodesService } from './recovery-codes.service';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly risk: RiskService,
    private readonly organizations: OrganizationsService,
    private readonly mfa: MfaVerifierService,
    private readonly recoveryCodes: RecoveryCodesService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async hashPassword(password: string) {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  async register(input: RegisterInput, req: Request) {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw DomainError.conflict('An account with this email already exists');
    const passwordHash = await this.hashPassword(input.password);
    const meta = requestMeta(req);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          country: input.country,
          locale: input.locale,
          phone: input.phone,
        },
      });
      await this.organizations.createPersonalOrganization(created, tx);
      await this.audit.log(
        {
          actorUserId: created.id,
          action: 'auth.register',
          entityType: 'User',
          entityId: created.id,
          ...meta,
        },
        tx,
      );
      return created;
    });
    const { token } = await this.sessions.create(user.id, req, { mfaVerified: true });
    return { user, token, mfaRequired: false };
  }

  async login(input: LoginInput, req: Request) {
    const meta = requestMeta(req);
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const genericError = () =>
      new DomainError(ErrorCode.UNAUTHENTICATED, 'Invalid email or password', HttpStatus.UNAUTHORIZED);
    if (!user || user.deletedAt) {
      // Constant-time-ish: still hash to avoid trivial user enumeration via timing
      await argon2
        .verify(
          '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          input.password,
        )
        .catch(() => false);
      throw genericError();
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
    const ok = await argon2.verify(user.passwordHash, input.password);
    if (!ok) {
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
        ...meta,
      });
      await this.risk.evaluateAndRecord({
        event: 'auth.login_failed',
        userId: user.id,
        failedLoginsLast15m: failed,
      });
      if (lock) {
        throw new DomainError(
          ErrorCode.ACCOUNT_LOCKED,
          'Too many attempts. Account locked for 15 minutes.',
          HttpStatus.LOCKED,
        );
      }
      throw genericError();
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const { token } = await this.sessions.create(user.id, req, { mfaVerified: !user.mfaEnabled });
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ...meta,
    });
    return { user, token, mfaRequired: user.mfaEnabled };
  }

  async logout(auth: AuthContext, req: Request) {
    await this.sessions.revoke(auth.sessionId);
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: auth.sessionId,
      ...requestMeta(req),
    });
  }

  // ── MFA (TOTP). Secrets are stored encrypted with the platform key (KeyPurpose.MFA). ──
  // Every code check goes through MfaVerifierService (anti-replay, recovery codes, passkeys).

  async mfaSetup(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.mfaEnabled) throw DomainError.conflict('MFA is already enabled');
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      // A new secret starts a fresh anti-replay history: steps of the old secret mean nothing.
      data: { mfaSecretEnc: sealString(this.env, KeyPurpose.MFA, secret), mfaLastUsedStep: null },
    });
    const otpauthUrl = authenticator.keyuri(user.email, 'Diaspora Trust (sandbox)', secret);
    return { secret, otpauthUrl };
  }

  /**
   * Confirms the enrolment with a code of the freshly configured app and the current password,
   * enables MFA and returns the 10 recovery codes — shown once, stored hashed (ADR-0009).
   * - the password is required: a stolen session alone must not attach its own second factor
   *   (it would lock the owner out and could then register a passkey with that factor);
   * - the confirmation code is burnt like any other code (no replay as a login proof);
   * - the account's other sessions are revoked: they were opened without the new factor.
   */
  async mfaEnable(auth: AuthContext, input: MfaEnableInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.mfaEnabled) throw DomainError.conflict('MFA is already enabled');
    if (!user.mfaSecretEnc) throw DomainError.validation('Run MFA setup first');
    const passwordOk = await argon2.verify(user.passwordHash, input.currentPassword).catch(() => false);
    if (!passwordOk) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'auth.mfa_enable_refused',
        entityType: 'User',
        entityId: user.id,
        metadata: { reason: 'password_invalid' },
        ...requestMeta(req),
      });
      throw new DomainError(
        ErrorCode.STEP_UP_REQUIRED,
        'Confirm your current password to enable two-factor authentication',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.mfa.verifyTotp(user.id, input.code, {
      consume: true,
      invalid: () => DomainError.validation('Invalid code'),
    });
    const recoveryCodes = await this.prisma.$transaction(async (db) => {
      await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaFailedCount: 0 } });
      const codes = await this.recoveryCodes.replaceAll(user.id, db);
      await this.audit.log(
        {
          actorUserId: user.id,
          action: 'auth.mfa_enabled',
          entityType: 'User',
          entityId: user.id,
          metadata: { recoveryCodesGenerated: codes.length },
          ...requestMeta(req),
        },
        db,
      );
      await this.notifications.notify(
        {
          userId: user.id,
          type: 'auth.mfa_enabled',
          title: 'Double authentification activée',
          body:
            'La double authentification a été activée sur votre compte et vos autres sessions ont ' +
            'été fermées. Si vous n’êtes pas à l’origine de cette opération, contactez le support.',
          data: {},
        },
        db,
      );
      return codes;
    });
    await this.sessions.revokeAllForUser(user.id, auth.sessionId);
    await this.sessions.markMfaVerified(auth.sessionId);
    return { enabled: true, recoveryCodes };
  }

  /** Login MFA step: TOTP code (anti-replay), recovery code or passkey assertion (STEP_UP). */
  async mfaVerify(auth: AuthContext, input: MfaVerifyInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw DomainError.validation('MFA is not enabled');
    let method: string;
    try {
      method = await this.mfa.assertFreshProof(
        auth,
        { mfaCode: input.code, passkeyAssertion: input.passkeyAssertion },
        'auth.login_mfa',
        { code: ErrorCode.MFA_REQUIRED, message: 'Invalid code' },
        req,
      );
    } catch (err) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'auth.mfa_failed',
        entityType: 'User',
        entityId: user.id,
        metadata: { reason: err instanceof DomainError ? err.code : 'error' },
        ...requestMeta(req),
      });
      throw err;
    }
    await this.sessions.markMfaVerified(auth.sessionId);
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.mfa_verified',
      entityType: 'Session',
      entityId: auth.sessionId,
      metadata: { method },
      ...requestMeta(req),
    });
    return { verified: true, method };
  }

  /** Disabling MFA is itself a step-up operation; recovery codes are discarded with the secret. */
  async mfaDisable(auth: AuthContext, input: MfaDisableInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw DomainError.validation('MFA is not enabled');
    const method = await this.mfa.assertFreshProof(
      auth,
      { mfaCode: input.code, passkeyAssertion: input.passkeyAssertion },
      'mfa.disable',
      { code: ErrorCode.VALIDATION_FAILED, message: 'Invalid code', status: HttpStatus.BAD_REQUEST },
      req,
    );
    await this.prisma.$transaction(async (db) => {
      await db.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false, mfaSecretEnc: null },
      });
      await this.recoveryCodes.deleteAll(user.id, db);
      await this.audit.log(
        {
          actorUserId: user.id,
          action: 'auth.mfa_disabled',
          entityType: 'User',
          entityId: user.id,
          metadata: { stepUp: method },
          ...requestMeta(req),
        },
        db,
      );
    });
    return { enabled: false };
  }

  /** Second factors of the account (also readable before the login MFA step). */
  async mfaStatus(auth: AuthContext) {
    const [user, passkeyCount, recovery] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { mfaEnabled: true } }),
      this.prisma.webAuthnCredential.count({ where: { userId: auth.userId, revokedAt: null } }),
      this.recoveryCodes.summary(auth.userId),
    ]);
    const methods: string[] = [];
    if (user.mfaEnabled) methods.push('totp', 'recovery_code');
    if (passkeyCount > 0) methods.push('passkey');
    return {
      mfaEnabled: user.mfaEnabled,
      passkeyCount,
      recoveryCodesRemaining: user.mfaEnabled ? recovery.remaining : 0,
      methods,
    };
  }

  async recoveryCodesSummary(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { mfaEnabled: true },
    });
    const summary = await this.recoveryCodes.summary(auth.userId);
    return {
      ...summary,
      remaining: user.mfaEnabled ? summary.remaining : 0,
      mfaEnabled: user.mfaEnabled,
      nextActions: user.mfaEnabled ? ['REGENERATE'] : [],
    };
  }

  /** New batch of recovery codes (old ones invalidated). Requires a fresh MFA proof. */
  async regenerateRecoveryCodes(auth: AuthContext, proof: RecoveryCodesRegenerateInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { mfaEnabled: true },
    });
    if (!user.mfaEnabled) throw DomainError.validation('MFA is not enabled');
    const method = await this.mfa.assertFreshProof(
      auth,
      proof,
      'mfa.recovery_codes_regenerate',
      {
        code: ErrorCode.STEP_UP_REQUIRED,
        message: 'A fresh second factor (code or passkey) is required to regenerate recovery codes',
      },
      req,
    );
    const recoveryCodes = await this.prisma.$transaction(async (db) => {
      const codes = await this.recoveryCodes.replaceAll(auth.userId, db);
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'auth.mfa_recovery_codes_regenerated',
          entityType: 'User',
          entityId: auth.userId,
          metadata: { stepUp: method, count: codes.length },
          ...requestMeta(req),
        },
        db,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'auth.mfa_recovery_codes_regenerated',
          title: 'Nouveaux codes de secours',
          body:
            'De nouveaux codes de secours ont été générés : les anciens ne fonctionnent plus. ' +
            'Si vous n’êtes pas à l’origine de cette opération, changez votre mot de passe immédiatement.',
          data: { count: codes.length },
        },
        db,
      );
      return codes;
    });
    return { recoveryCodes };
  }

  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await argon2.verify(user.passwordHash, currentPassword)))
      throw DomainError.validation('Current password is incorrect');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.hashPassword(newPassword) },
    });
    await this.sessions.revokeAllForUser(user.id, auth.sessionId);
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.password_changed',
      entityType: 'User',
      entityId: user.id,
      ...requestMeta(req),
    });
    return { changed: true };
  }

  /** Used by tests & seed to produce deterministic hashes of invitation tokens etc. */
  static tokenHash(token: string) {
    return sha256Hex(token);
  }
}
