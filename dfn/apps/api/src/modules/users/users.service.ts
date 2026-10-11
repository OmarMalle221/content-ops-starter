import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { UpdateProfileInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: { include: { organization: true } },
        identityVerifications: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const latestVerification = user.identityVerifications[0];
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      country: user.country,
      locale: user.locale,
      globalRole: user.globalRole,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      identityVerification: latestVerification
        ? {
            id: latestVerification.id,
            status: latestVerification.status,
            level: latestVerification.level,
            provider: latestVerification.provider,
            simulated: latestVerification.provider === 'sandbox',
          }
        : { status: 'NOT_STARTED', simulated: true },
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        type: m.organization.type,
        country: m.organization.country,
        role: m.role,
        verificationStatus: m.organization.verificationStatus,
      })),
    };
  }

  async updateProfile(auth: AuthContext, input: UpdateProfileInput, req: Request) {
    await this.prisma.user.update({ where: { id: auth.userId }, data: input });
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'user.profile_updated',
      entityType: 'User',
      entityId: auth.userId,
      metadata: { fields: Object.keys(input) },
      ...requestMeta(req),
    });
    return this.me(auth.userId);
  }

  /** Builds an AuthContext for server-side flows that act on behalf of a just-created user. */
  async authContextFor(userId: string, req: Request): Promise<AuthContext> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { organization: true } } },
    });
    const meta = requestMeta(req);
    return {
      userId: user.id,
      sessionId: 'system',
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      locale: user.locale,
      globalRole: user.globalRole,
      mfaEnabled: user.mfaEnabled,
      mfaVerified: true,
      memberships: user.memberships.map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organization.name,
        organizationType: m.organization.type,
        role: m.role,
      })),
      ...meta,
    };
  }
}
