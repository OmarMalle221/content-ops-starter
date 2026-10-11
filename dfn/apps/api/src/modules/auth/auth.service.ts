import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import type { Request } from 'express';
import { ErrorCode, type LoginInput, type RegisterInput, KeyPurpose } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { sha256Hex } from '../../common/crypto';
import { openString, sealString } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { RiskService } from '../risk/risk.service';
import { SessionService } from './session.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { AuthContext } from '../../common/auth-context';

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

  // ── MFA (TOTP). Secrets are stored encrypted with the platform key. ──
  async mfaSetup(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.mfaEnabled) throw DomainError.conflict('MFA is already enabled');
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: sealString(this.env, KeyPurpose.MFA, secret) },
    });
    const otpauthUrl = authenticator.keyuri(user.email, 'Diaspora Trust (sandbox)', secret);
    return { secret, otpauthUrl };
  }

  async mfaEnable(auth: AuthContext, code: string, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaSecretEnc) throw DomainError.validation('Run MFA setup first');
    const secret = openString(this.env, KeyPurpose.MFA, user.mfaSecretEnc);
    if (!authenticator.verify({ token: code, secret })) throw DomainError.validation('Invalid code');
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await this.sessions.markMfaVerified(auth.sessionId);
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.mfa_enabled',
      entityType: 'User',
      entityId: user.id,
      ...requestMeta(req),
    });
    return { enabled: true };
  }

  async mfaVerify(auth: AuthContext, code: string, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw DomainError.validation('MFA is not enabled');
    const secret = openString(this.env, KeyPurpose.MFA, user.mfaSecretEnc);
    if (!authenticator.verify({ token: code, secret })) {
      await this.audit.log({
        actorUserId: user.id,
        action: 'auth.mfa_failed',
        entityType: 'User',
        entityId: user.id,
        ...requestMeta(req),
      });
      throw new DomainError(ErrorCode.MFA_REQUIRED, 'Invalid code', HttpStatus.UNAUTHORIZED);
    }
    await this.sessions.markMfaVerified(auth.sessionId);
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.mfa_verified',
      entityType: 'Session',
      entityId: auth.sessionId,
      ...requestMeta(req),
    });
    return { verified: true };
  }

  async mfaDisable(auth: AuthContext, code: string, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw DomainError.validation('MFA is not enabled');
    const secret = openString(this.env, KeyPurpose.MFA, user.mfaSecretEnc);
    if (!authenticator.verify({ token: code, secret })) throw DomainError.validation('Invalid code');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
    await this.audit.log({
      actorUserId: user.id,
      action: 'auth.mfa_disabled',
      entityType: 'User',
      entityId: user.id,
      ...requestMeta(req),
    });
    return { enabled: false };
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
