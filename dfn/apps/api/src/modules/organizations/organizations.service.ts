import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgRole, Prisma, PrismaTransactionClient, User } from '@dfn/database';
import {
  ErrorCode,
  ORG_ROLE_PERMISSIONS,
  Permission,
  SUPPORT_REASON_HEADER,
  globalRoleHas,
  isStaff as isStaffRole,
  orgRoleHas,
  supportReasonSchema,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type SubmitBusinessVerificationInput,
} from '@dfn/shared';
import { createKycProvider } from '@dfn/compliance';
import { isStaff, membershipFor, type AuthContext, type AuthMembership } from '../../common/auth-context';
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

  /**
   * Resolves the organisation the user acts for; defaults to the personal workspace.
   * Real memberships only: staff get no implicit access here (money movement, partner credentials,
   * Protect transactions…). Business / organisation writes by support staff go through
   * `resolveActingOrganizationForWrite` instead.
   */
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

  /**
   * Same as `resolveActingOrganization` for an explicit organisation, plus audited staff support
   * writes (see `authorizeWrite`). Without `organizationId`, the caller's own workspace is used.
   */
  async resolveActingOrganizationForWrite(
    auth: AuthContext,
    organizationId: string | undefined,
    permission: Permission,
    req: Request,
  ): Promise<TenantAccess> {
    if (!organizationId) {
      return { ...this.resolveActingOrganization(auth, undefined, permission), via: 'MEMBERSHIP' };
    }
    return this.authorizeWrite(auth, organizationId, permission, req);
  }

  /**
   * Synchronous tenant check. Members are checked against their organisation role. Staff (ADMIN /
   * COMPLIANCE) who are NOT members only get READ access — the intent is derived from the required
   * permission (no permission or a read permission = read). A write by a non-member staff user is
   * refused here: support writes must use `authorizeWrite`, which records the support audit.
   * Anyone else gets a 404 (no existence leak).
   */
  assertMember(
    auth: AuthContext,
    organizationId: string,
    permission?: Permission,
    intent: TenantAccessIntent = intentOf(permission),
  ): TenantAccess {
    const m = membershipFor(auth, organizationId);
    if (m) {
      if (permission && !orgRoleHas(m.role, permission)) throw DomainError.forbidden();
      return { ...m, via: 'MEMBERSHIP' };
    }
    if (!isStaffActor(auth)) throw DomainError.notFound('Organization');
    if (intent === 'read') return { organizationId, role: 'VIEWER', via: 'STAFF_READ' };
    throw staffWriteRefusal(auth, permission);
  }

  /**
   * Write check with staff support. Members: role check. Non-member staff: only ADMIN
   * (Permission.ADMIN_SUPPORT_WRITE), only for business / organisation administration permissions
   * (never money movement, credentials or link consent), only with a justification in the
   * `X-Support-Reason` header — and every such access is audited as `support.write` BEFORE the
   * action runs. COMPLIANCE (read-only) gets 403. Anyone else gets 404.
   */
  async authorizeWrite(
    auth: AuthContext,
    organizationId: string,
    permission: Permission,
    req: Request,
  ): Promise<TenantAccess> {
    const m = membershipFor(auth, organizationId);
    if (m) {
      if (!orgRoleHas(m.role, permission)) {
        throw DomainError.forbidden(`Your role (${m.role}) does not allow this action`);
      }
      return { ...m, via: 'MEMBERSHIP' };
    }
    if (!isStaffActor(auth)) throw DomainError.notFound('Organization');
    if (
      !globalRoleHas(auth.globalRole, Permission.ADMIN_SUPPORT_WRITE) ||
      !SUPPORT_WRITABLE.has(permission)
    ) {
      throw staffWriteRefusal(auth, permission);
    }
    const { reason, organizationName } = await this.recordSupportWrite(auth, organizationId, permission, req);
    return {
      organizationId,
      organizationName,
      role: 'OWNER',
      via: 'STAFF_SUPPORT',
      supportReason: reason,
    };
  }

  /**
   * Staff support action that is not an organisation permission (e.g. deleting a document someone
   * else uploaded): ADMIN_SUPPORT_WRITE, an `X-Support-Reason` and a `support.write` audit entry
   * written before the action, whether or not the staff member also belongs to the organisation.
   */
  async authorizeSupportAction(auth: AuthContext, organizationId: string, action: string, req: Request) {
    if (!isStaffActor(auth) || !globalRoleHas(auth.globalRole, Permission.ADMIN_SUPPORT_WRITE)) {
      throw DomainError.forbidden();
    }
    return this.recordSupportWrite(auth, organizationId, action, req);
  }

  private async recordSupportWrite(
    auth: AuthContext,
    organizationId: string,
    permission: string,
    req: Request,
  ): Promise<{ reason: string; organizationName: string }> {
    const reason = supportReasonFrom(req);
    if (!reason) {
      throw DomainError.validation(
        'Staff write access to an organisation you do not belong to requires a support reason (X-Support-Reason header, 10–500 characters)',
        { header: SUPPORT_REASON_HEADER },
      );
    }
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!org) throw DomainError.notFound('Organization');
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId,
      action: 'support.write',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: {
        support: true,
        reason,
        permission,
        globalRole: auth.globalRole,
        method: req.method,
        path: (req.originalUrl ?? req.url ?? '').split('?')[0],
      },
      ...requestMeta(req),
    });
    return { reason, organizationName: org.name };
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
    this.assertMember(auth, id); // read: members and staff
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
    const access = await this.authorizeWrite(auth, organizationId, Permission.ORG_MANAGE_MEMBERS, req);
    const support = access.via === 'STAFF_SUPPORT';
    if (support) await this.assertSupportInvite(auth, input.email, input.role);
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
      metadata: {
        role: input.role,
        support,
        ...(support ? { supportReason: access.supportReason } : {}),
      },
      ...requestMeta(req),
    });
    if (support) await this.notifySupportInvitation(organizationId, input, invitation.id, access);
    // The token is returned once so the inviter can share the link (sandbox email transport is
    // log-only) — except to support staff: the invitee alone receives it.
    if (support) return { invitationId: invitation.id, token: null, acceptUrl: null };
    return {
      invitationId: invitation.id,
      token,
      acceptUrl: `${this.env.WEB_PUBLIC_URL}/invite/org/${token}`,
    };
  }

  /**
   * A support write manages members for the organisation, never for the staff member: no
   * invitation of oneself or of another staff account (which would turn read-only staff into a
   * tenant member), and only a read-only role (SUPPORT_GRANTABLE_ROLES, i.e. VIEWER) — an ordinary
   * account the agent controls must not gain money movement, credentials or link consent either.
   * The invitation model has no owner-approval state, so the owners are told instead
   * (`notifySupportInvitation`) and can remove the member.
   */
  private async assertSupportInvite(auth: AuthContext, email: string, role: OrgRole) {
    if (!SUPPORT_GRANTABLE_ROLES.has(role)) throw supportMembershipRefusal();
    if (email.trim().toLowerCase() === auth.email.trim().toLowerCase()) throw supportMembershipRefusal();
    const invitee = await this.prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
      select: { globalRole: true },
    });
    if (invitee && isStaffRole(invitee.globalRole)) throw supportMembershipRefusal();
  }

  /** Every support-initiated invitation is reported to the members who manage members (OWNER / ADMIN). */
  private async notifySupportInvitation(
    organizationId: string,
    input: InviteMemberInput,
    invitationId: string,
    access: TenantAccess,
  ) {
    const managers = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true },
    });
    await this.notifications.notifyMany(
      managers.map((m) => m.userId),
      {
        type: 'organization.support_invitation',
        title: `Invitation envoyée par le support — ${access.organizationName ?? organizationId}`,
        body: `Le support a invité ${input.email} avec le rôle ${input.role} (lecture seule). Motif : ${access.supportReason ?? '—'}. Si vous ne l'attendiez pas, retirez ce membre après son arrivée et contactez le support.`,
        data: { organizationId, invitationId, email: input.email, role: input.role },
      },
    );
  }

  /** Support-initiated: the inviter is staff without a membership of the organisation. */
  private async sentBySupport(invitation: { organizationId: string; invitedByUserId: string }) {
    const inviter = await this.prisma.user.findUnique({
      where: { id: invitation.invitedByUserId },
      select: {
        globalRole: true,
        memberships: { where: { organizationId: invitation.organizationId }, select: { id: true } },
      },
    });
    return Boolean(inviter && isStaffRole(inviter.globalRole) && inviter.memberships.length === 0);
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
    // Same rule on acceptance, so an invitation sent by support with a wider role (e.g. one pending
    // from before support grants were limited) can never open money movement either.
    if (!SUPPORT_GRANTABLE_ROLES.has(invitation.role) && (await this.sentBySupport(invitation))) {
      throw supportMembershipRefusal();
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
    const actor = await this.authorizeWrite(auth, organizationId, Permission.ORG_MANAGE_MEMBERS, req);
    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!member) throw DomainError.notFound('Member');
    // Support may only set a read-only role (SUPPORT_GRANTABLE_ROLES), never touch an owner.
    if (actor.via === 'STAFF_SUPPORT' && (!SUPPORT_GRANTABLE_ROLES.has(role) || member.role === 'OWNER')) {
      throw supportMembershipRefusal();
    }
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
    const actor = await this.authorizeWrite(auth, organizationId, Permission.ORG_MANAGE_MEMBERS, req);
    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!member) throw DomainError.notFound('Member');
    if (actor.via === 'STAFF_SUPPORT' && member.role === 'OWNER') throw supportMembershipRefusal();
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
    await this.authorizeWrite(auth, organizationId, Permission.ORG_MANAGE_SETTINGS, req);
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
}

// ───────────────────────────── Tenant access model ──────────────────────────

export type TenantAccessIntent = 'read' | 'write';

/** MEMBERSHIP = real membership; STAFF_READ = staff read-only access; STAFF_SUPPORT = audited support write. */
export type TenantAccessVia = 'MEMBERSHIP' | 'STAFF_READ' | 'STAFF_SUPPORT';

export interface TenantAccess {
  organizationId: string;
  role: OrgRole;
  via: TenantAccessVia;
  organizationName?: string;
  organizationType?: AuthMembership['organizationType'];
  /** STAFF_SUPPORT only: the justification recorded in the `support.write` audit entry. */
  supportReason?: string;
}

/** Permissions that only read tenant data (staff keep read access to every organisation). */
const READ_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  Permission.TRANSACTION_READ,
  Permission.WALLET_READ,
  Permission.ORG_VIEW_REPORTS,
]);

/**
 * Writes an ADMIN may perform for support inside an organisation he does not belong to: client
 * records, invoices / quotes, members and organisation settings. Never: transfers, wallet payments,
 * beneficiaries, partner credentials, Protect transactions or link consent (ORG_LINK_DECIDE).
 */
const SUPPORT_WRITABLE: ReadonlySet<Permission> = new Set<Permission>([
  Permission.TRANSACTION_CREATE,
  Permission.INVOICE_MANAGE,
  Permission.ORG_MANAGE_MEMBERS,
  Permission.ORG_MANAGE_SETTINGS,
]);

/**
 * Roles a support write may grant (invitation or role change): read-only roles only, i.e. every
 * permission of the role is a READ_PERMISSIONS entry — today VIEWER alone. OWNER and ADMIN carry
 * credentials, member management and link consent; OWNER, ADMIN and MEMBER all move money
 * (TRANSACTION_MANAGE funds and releases Protect escrow; TRANSFER_CREATE pays invoices from the
 * wallet). An account a support agent controls can therefore never obtain money movement from a
 * support invitation.
 * Derived from the RBAC matrix so a write permission added to a role removes it from this set.
 */
const SUPPORT_GRANTABLE_ROLES: ReadonlySet<OrgRole> = new Set<OrgRole>(
  (Object.keys(ORG_ROLE_PERMISSIONS) as OrgRole[]).filter((role) =>
    ORG_ROLE_PERMISSIONS[role].every((permission) => READ_PERMISSIONS.has(permission)),
  ),
);

function supportMembershipRefusal(): DomainError {
  return DomainError.forbidden(
    `Support cannot invite itself or other staff, grant a role other than ${[...SUPPORT_GRANTABLE_ROLES].join(' / ')} (read-only), or change an owner`,
  );
}

export function intentOf(permission?: Permission): TenantAccessIntent {
  return !permission || READ_PERMISSIONS.has(permission) ? 'read' : 'write';
}

/** Staff role on a session (API keys always act as the key's organisation, never as staff). */
function isStaffActor(auth: AuthContext): boolean {
  return isStaff(auth) && !auth.apiCredential;
}

function staffWriteRefusal(auth: AuthContext, permission?: Permission): DomainError {
  if (!globalRoleHas(auth.globalRole, Permission.ADMIN_SUPPORT_WRITE)) {
    return DomainError.forbidden(
      'Staff accounts have read-only access to organisations they do not belong to',
    );
  }
  return DomainError.forbidden(
    `Support access cannot perform this action on behalf of an organisation${permission ? ` (${permission})` : ''}`,
  );
}

/** Reads and validates the support justification header (URI-encoded values are decoded). */
function supportReasonFrom(req: Request): string | null {
  const raw = req.headers[SUPPORT_REASON_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* not URI-encoded: keep the raw value */
  }
  const parsed = supportReasonSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
