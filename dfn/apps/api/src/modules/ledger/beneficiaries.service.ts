import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Beneficiary } from '@dfn/database';
import {
  Permission,
  orgRoleHas,
  type CreateBeneficiaryInput,
  type ListBeneficiariesQuery,
  KeyPurpose,
} from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { sealString } from '../../common/keyring';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RiskService } from '../risk/risk.service';

/** Wire format shared with the Transfers feature. The clear account identifier is never exposed. */
export interface BeneficiaryDto {
  id: string;
  organizationId: string;
  name: string;
  country: string;
  currencyCode: string;
  method: Beneficiary['method'];
  accountIdentifierMasked: string;
  institutionName: string | null;
  phone: string | null;
  email: string | null;
  status: Beneficiary['status'];
  createdAt: Date;
}

/** Keeps the last 4 characters of the identifier; everything else is replaced by bullets. */
export function maskAccountIdentifier(identifier: string): string {
  const compact = identifier.replace(/\s+/g, '');
  const tail = compact.slice(-4);
  return `••••${tail}`;
}

export function toBeneficiaryDto(b: Beneficiary): BeneficiaryDto {
  return {
    id: b.id,
    organizationId: b.organizationId,
    name: b.name,
    country: b.country,
    currencyCode: b.currencyCode,
    method: b.method,
    accountIdentifierMasked: b.accountIdentifierMasked,
    institutionName: b.institutionName,
    phone: b.phone,
    email: b.email,
    status: b.status,
    createdAt: b.createdAt,
  };
}

@Injectable()
export class BeneficiariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(auth: AuthContext, query: ListBeneficiariesQuery) {
    // Reading is open to every member of the organisation (masked data only); staff may read any.
    const membership = query.organizationId
      ? this.organizations.assertMember(auth, query.organizationId)
      : this.organizations.resolveActingOrganization(auth);
    const items = await this.prisma.beneficiary.findMany({
      where: {
        organizationId: membership.organizationId,
        ...(query.includeRemoved ? {} : { status: 'ACTIVE' }),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return { items: items.map(toBeneficiaryDto) };
  }

  /** Loads a beneficiary the caller may see; other tenants get 404, never 403. */
  async loadFor(auth: AuthContext, id: string): Promise<Beneficiary> {
    const beneficiary = await this.prisma.beneficiary.findUnique({ where: { id } });
    if (!beneficiary) throw DomainError.notFound('Beneficiary');
    if (!isStaff(auth) && !membershipFor(auth, beneficiary.organizationId)) {
      throw DomainError.notFound('Beneficiary');
    }
    return beneficiary;
  }

  async create(auth: AuthContext, input: CreateBeneficiaryInput, req: Request): Promise<BeneficiaryDto> {
    const membership = this.organizations.resolveActingOrganization(
      auth,
      input.organizationId,
      Permission.BENEFICIARY_MANAGE,
    );
    const organizationId = membership.organizationId;
    const identifier = input.accountIdentifier.replace(/\s+/g, '');
    const meta = requestMeta(req);
    const created = await this.prisma.$transaction(async (db) => {
      const row = await db.beneficiary.create({
        data: {
          organizationId,
          createdByUserId: auth.userId,
          name: input.name,
          country: input.country,
          currencyCode: input.currencyCode,
          method: input.method,
          accountIdentifierEnc: sealString(this.env, KeyPurpose.BENEFICIARIES, identifier),
          accountIdentifierMasked: maskAccountIdentifier(identifier),
          institutionName: input.institutionName ?? null,
          // A phone identical to the account identifier would expose it in clear text next to the
          // encrypted, masked identifier: it is dropped (the identifier already reaches the payee).
          phone:
            input.phone && input.phone.replace(/\s/g, '') !== identifier.replace(/\s/g, '')
              ? input.phone
              : null,
          email: input.email ?? null,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: 'beneficiary.created',
          entityType: 'Beneficiary',
          entityId: row.id,
          metadata: {
            method: row.method,
            country: row.country,
            currencyCode: row.currencyCode,
            accountIdentifierMasked: row.accountIdentifierMasked,
          },
          ...meta,
        },
        db,
      );
      return row;
    });
    await this.afterChange(auth, organizationId, created, 'added');
    return toBeneficiaryDto(created);
  }

  async remove(auth: AuthContext, id: string, req: Request): Promise<BeneficiaryDto> {
    const existing = await this.loadFor(auth, id);
    // Managing beneficiaries is reserved to actual members with the permission (no staff bypass).
    const membership = membershipFor(auth, existing.organizationId);
    if (!membership || !orgRoleHas(membership.role, Permission.BENEFICIARY_MANAGE)) {
      throw DomainError.forbidden('Your role does not allow managing beneficiaries of this organisation');
    }
    if (existing.status === 'REMOVED') {
      throw DomainError.invalidTransition('Beneficiary is already removed', {
        entity: 'Beneficiary',
        from: existing.status,
        to: 'REMOVED',
      });
    }
    const meta = requestMeta(req);
    const removed = await this.prisma.$transaction(async (db) => {
      const row = await db.beneficiary.update({
        where: { id: existing.id },
        data: { status: 'REMOVED', removedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: existing.organizationId,
          action: 'beneficiary.removed',
          entityType: 'Beneficiary',
          entityId: row.id,
          metadata: { accountIdentifierMasked: row.accountIdentifierMasked },
          ...meta,
        },
        db,
      );
      return row;
    });
    await this.afterChange(auth, existing.organizationId, removed, 'removed');
    return toBeneficiaryDto(removed);
  }

  /** Number of beneficiary additions/removals for the organisation in the last 24 hours. */
  async changesLast24h(organizationId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    return this.prisma.beneficiary.count({
      where: { organizationId, OR: [{ createdAt: { gte: since } }, { removedAt: { gte: since } }] },
    });
  }

  private async afterChange(
    auth: AuthContext,
    organizationId: string,
    beneficiary: Beneficiary,
    change: 'added' | 'removed',
  ) {
    const beneficiaryChangesLast24h = await this.changesLast24h(organizationId);
    await this.risk.evaluateAndRecord({
      event: 'beneficiary.changed',
      userId: auth.userId,
      organizationId,
      beneficiaryChangesLast24h,
    });
    const managers = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true },
    });
    const recipients = managers.map((m) => m.userId);
    if (!recipients.includes(auth.userId)) recipients.push(auth.userId);
    const added = change === 'added';
    await this.notifications.notifyMany(recipients, {
      type: added ? 'beneficiary.added' : 'beneficiary.removed',
      title: added ? 'Bénéficiaire ajouté' : 'Bénéficiaire retiré',
      body: added
        ? `Le bénéficiaire « ${beneficiary.name} » (${beneficiary.accountIdentifierMasked}, ${beneficiary.currencyCode}) a été ajouté par ${auth.firstName} ${auth.lastName}. Sandbox — aucun fonds réel.`
        : `Le bénéficiaire « ${beneficiary.name} » (${beneficiary.accountIdentifierMasked}) a été retiré par ${auth.firstName} ${auth.lastName}. Sandbox — aucun fonds réel.`,
      data: { beneficiaryId: beneficiary.id, organizationId },
    });
  }
}
