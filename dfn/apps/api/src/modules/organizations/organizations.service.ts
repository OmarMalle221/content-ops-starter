import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgRole, Prisma, PrismaTransactionClient, User } from '@dfn/database';
import {
  ErrorCode,
  Permission,
  orgRoleHas,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type SubmitBusinessVerificationInput,
} from '@dfn/shared';
import { createKycProvider } from '@dfn/compliance';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { randomToken, sha256Hex } from '../../common/crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OrganizationsService {
  private readonly kyc;
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.kyc = createKycProvider(env.KYC_PROVIDER);
  }

  /** Every user owns a personal workspace used for individual (non-business) transactions. */
  async createPersonalOrganization(user: User, tx: PrismaTransactionClient) {
    return tx.organization.create({
      data: {
        name: `${user.firstName} ${user.lastName}`,
        type: 'PERSONAL',
        country: user.country ?? 'CA',
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
  }

  /** Resolves the organisation the user acts for; defaults to the personal workspace. */
  resolveActingOrganization(auth: AuthContext, organizationId?: string, permission?: Permission) {
    const membership = organizationId
      ? membershipFor(auth, organizationId)
      : (auth.memberships.find((m) => m.organizationType === 'PERSONAL') ?? auth.memberships[0]);
    if (!membership) throw DomainError.notFound('Organization');
    if (permission && !orgRoleHas(membership.role, permission)) {
      throw DomainError.forbidden(`Your role (${membership.role}) does not allow this action`);
    }
    return membership;
  }

  assertMember(auth: AuthContext, organizationId: string, permission?: Permission) {
    if (isStaff(auth)) return { organizationId, role: 'OWNER' as OrgRole };
    const m = membershipFor(auth, organizationId);
    if (!m) throw DomainError.notFound('Organization');
    if (permission && !orgRoleHas(m.role, permission)) throw DomainError.forbidden();
    return m;
  }

  async listMine(auth: AuthContext) {
    const orgs = await this.prisma.organization.findMany({
      where: { members: { some: { userId: auth.userId } }, deletedAt: null },
      include: { _count: { select: { members: true, buyerTransactions: true, sellerTransactions: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return orgs.map((o) => ({ ...o, role: membershipFor(auth, o.id)?.role }));
  }

  async get(auth: AuthContext, id: string) {
    this.assertMember(auth, id);
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      include: {
        members: {
          include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
        },
        invitations: { where: { acceptedAt: null, expiresAt: { gt: new Date() } } },
        businessVerifications: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!org) throw DomainError.notFound('Organization');
    return org;
  }

  async createBusiness(auth: AuthContext, input: CreateOrganizationInput, req: Request) {
    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: { ...input, type: 'BUSINESS', members: { create: { userId: auth.userId, role: 'OWNER' } } },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: created.id,
          action: 'organization.created',
          entityType: 'Organization',
          entityId: created.id,
          ...requestMeta(req),
        },
        tx,
      );
      return created;
    });
    return org;
  }

  async inviteMember(auth: AuthContext, organizationId: string, input: InviteMemberInput, req: Request) {
    this.assertMember(auth, organizationId, Permission.ORG_MANAGE_MEMBERS);
    const token = randomToken(24);
    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        organizationId,
        email: input.email,
        role: input.role,
        tokenHash: sha256Hex(token),
        invitedByUserId: auth.userId,
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
      },
    });
    const existingUser = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existingUser) {
      await this.notifications.notify({
        userId: existingUser.id,
        type: 'organization.invited',
        title: 'Invitation à rejoindre une organisation',
        body: `Vous avez été invité·e à rejoindre une organisation sur Diaspora Trust (sandbox).`,
        data: { organizationId, invitationToken: token },
      });
    }
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId,
      action: 'organization.member_invited',
      entityType: 'OrganizationInvitation',
      entityId: invitation.id,
      metadata: { role: input.role },
      ...requestMeta(req),
    });
    // The token is returned once so the inviter can share the link (sandbox email transport is log-only).
    return {
      invitationId: invitation.id,
      token,
      acceptUrl: `${this.env.WEB_PUBLIC_URL}/invite/org/${token}`,
    };
  }

  async acceptMemberInvitation(auth: AuthContext, token: string, req: Request) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash: sha256Hex(token) },
    });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
      throw new DomainError(
        ErrorCode.INVITATION_INVALID,
        'Invitation is invalid or expired',
        HttpStatus.GONE,
      );
    }
    if (invitation.email.toLowerCase() !== auth.email.toLowerCase()) {
      throw DomainError.forbidden('This invitation was sent to another email address');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId: auth.userId } },
        update: { role: invitation.role },
        create: { organizationId: invitation.organizationId, userId: auth.userId, role: invitation.role },
      });
      await tx.organizationInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: invitation.organizationId,
          action: 'organization.member_joined',
          entityType: 'Organization',
          entityId: invitation.organizationId,
          ...requestMeta(req),
        },
        tx,
      );
    });
    return { organizationId: invitation.organizationId, role: invitation.role };
  }

  async updateMemberRole(
    auth: AuthContext,
    organizationId: string,
    memberId: string,
    role: OrgRole,
    req: Request,
  ) {
    const actor = this.assertMember(auth, organizationId, Permission.ORG_MANAGE_MEMBERS);
    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!member) throw DomainError.notFound('Member');
    if (member.role === 'OWNER' && actor.role !== 'OWNER')
      throw DomainError.forbidden('Only an owner can change an owner');
    if (member.role === 'OWNER' && role !== 'OWNER') {
      const owners = await this.prisma.organizationMember.count({ where: { organizationId, role: 'OWNER' } });
      if (owners <= 1) throw DomainError.conflict('An organisation must keep at least one owner');
    }
    const updated = await this.prisma.organizationMember.update({ where: { id: memberId }, data: { role } });
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId,
      action: 'organization.member_role_changed',
      entityType: 'OrganizationMember',
      entityId: memberId,
      metadata: { from: member.role, to: role },
      ...requestMeta(req),
    });
    return updated;
  }

  async removeMember(auth: AuthContext, organizationId: string, memberId: string, req: Request) {
    this.assertMember(auth, organizationId, Permission.ORG_MANAGE_MEMBERS);
    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!member) throw DomainError.notFound('Member');
    if (member.role === 'OWNER') {
      const owners = await this.prisma.organizationMember.count({ where: { organizationId, role: 'OWNER' } });
      if (owners <= 1) throw DomainError.conflict('An organisation must keep at least one owner');
    }
    await this.prisma.organizationMember.delete({ where: { id: memberId } });
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId,
      action: 'organization.member_removed',
      entityType: 'OrganizationMember',
      entityId: memberId,
      ...requestMeta(req),
    });
    return { removed: true };
  }

  async submitBusinessVerification(
    auth: AuthContext,
    organizationId: string,
    input: SubmitBusinessVerificationInput,
    req: Request,
  ) {
    this.assertMember(auth, organizationId, Permission.ORG_MANAGE_SETTINGS);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.type !== 'BUSINESS')
      throw DomainError.validation('Business verification applies to business organisations only');
    const result = await this.kyc.startBusinessCheck({ organizationId, ...input });
    const record = await this.prisma.$transaction(async (tx) => {
      const created = await tx.businessVerification.create({
        data: {
          organizationId,
          provider: result.provider,
          providerRef: result.providerRef,
          status: result.status,
          declaredData: input as unknown as Prisma.InputJsonValue,
          providerResponse: result as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          verificationStatus: result.status,
          legalName: input.legalName,
          registrationNumber: input.registrationNumber,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: 'organization.verification_submitted',
          entityType: 'BusinessVerification',
          entityId: created.id,
          metadata: { status: result.status, simulated: result.simulated },
          ...requestMeta(req),
        },
        tx,
      );
      return created;
    });
    return { ...record, simulated: result.simulated };
  }

  async listCounterparties(auth: AuthContext, organizationId: string) {
    this.assertMember(auth, organizationId);
    return this.prisma.counterparty.findMany({ where: { organizationId }, orderBy: { name: 'asc' } });
  }

  async createCounterparty(
    auth: AuthContext,
    organizationId: string,
    input: { name: string; email?: string; phone?: string; country?: string; notes?: string },
    req: Request,
  ) {
    this.assertMember(auth, organizationId, Permission.TRANSACTION_CREATE);
    const cp = await this.prisma.counterparty.create({ data: { organizationId, ...input } });
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId,
      action: 'counterparty.created',
      entityType: 'Counterparty',
      entityId: cp.id,
      ...requestMeta(req),
    });
    return cp;
  }
}
