import { Injectable } from '@nestjs/common';
import type { OrgRole, Prisma, PrismaTransactionClient } from '@dfn/database';
import { Permission, orgRoleHas } from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';

export const transactionInclude = {
  parties: {
    include: {
      organization: { select: { id: true, name: true, type: true, country: true, verificationStatus: true } },
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  },
  contract: { include: { currentVersion: { include: { acceptances: { include: { party: true } } } } } },
  milestones: {
    orderBy: { sequence: 'asc' as const },
    include: {
      evidences: {
        include: {
          document: {
            select: {
              id: true,
              title: true,
              kind: true,
              fileName: true,
              status: true,
              mimeType: true,
              scanStatus: true,
              scanEngine: true,
              scannedAt: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  },
  fundingRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 3,
    include: { provider: { select: { code: true, name: true, mode: true } } },
  },
  disputes: {
    orderBy: { openedAt: 'desc' as const },
    select: { id: true, status: true, reason: true, openedAt: true, closedAt: true },
  },
  _count: { select: { documents: true } },
} satisfies Prisma.TransactionInclude;

export type TransactionWithRelations = Prisma.TransactionGetPayload<{ include: typeof transactionInclude }>;
export type ViewerRole = 'BUYER' | 'SELLER' | 'STAFF';

@Injectable()
export class TransactionAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async load(
    id: string,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<TransactionWithRelations> {
    const tx = await db.transaction.findUnique({ where: { id }, include: transactionInclude });
    if (!tx) throw DomainError.notFound('Transaction');
    return tx;
  }

  roleFor(auth: AuthContext, tx: TransactionWithRelations): ViewerRole | null {
    if (membershipFor(auth, tx.buyerOrganizationId)) return 'BUYER';
    const seller = tx.parties.find((p) => p.role === 'SELLER');
    if (tx.sellerOrganizationId && membershipFor(auth, tx.sellerOrganizationId)) return 'SELLER';
    if (seller?.userId === auth.userId) return 'SELLER';
    if (isStaff(auth)) return 'STAFF';
    return null;
  }

  /** Loads a transaction the user may see; cross-tenant access yields 404 (no existence leak). */
  async loadFor(auth: AuthContext, id: string, db?: PrismaTransactionClient | PrismaService) {
    const tx = await this.load(id, db);
    const role = this.roleFor(auth, tx);
    if (!role) throw DomainError.notFound('Transaction');
    return { tx, role };
  }

  assertRole(role: ViewerRole | null, ...allowed: ViewerRole[]) {
    if (!role || !allowed.includes(role)) throw DomainError.forbidden();
  }

  /**
   * Organisation role the caller holds on its side of the transaction: its membership of the buyer
   * organisation (BUYER) or of the seller organisation (SELLER). Null for staff and for a seller who
   * is not (or no longer) a member of the organisation the transaction is attached to.
   */
  partyOrgRole(auth: AuthContext, tx: TransactionWithRelations, role: ViewerRole | null): OrgRole | null {
    const organizationId =
      role === 'BUYER' ? tx.buyerOrganizationId : role === 'SELLER' ? tx.sellerOrganizationId : null;
    return (organizationId && membershipFor(auth, organizationId)?.role) || null;
  }

  /**
   * `assertRole` for a state-changing party action (terms, funding, milestone submission / review /
   * approval — which releases escrow —, cancellation, invitation resend): the caller acts for its
   * organisation, so its organisation role must also grant TRANSACTION_MANAGE. A VIEWER of either
   * side keeps read access only. Staff never pass (no party role).
   */
  assertPartyCan(
    auth: AuthContext,
    tx: TransactionWithRelations,
    role: ViewerRole | null,
    ...allowed: Array<'BUYER' | 'SELLER'>
  ) {
    this.assertPartyPermission(auth, tx, role, Permission.TRANSACTION_MANAGE, ...allowed);
  }

  /**
   * Same rule for party actions guarded by another organisation permission (DISPUTE_OPEN for
   * disputes, DOCUMENT_UPLOAD for transaction documents).
   */
  assertPartyPermission(
    auth: AuthContext,
    tx: TransactionWithRelations,
    role: ViewerRole | null,
    permission: Permission,
    ...allowed: Array<'BUYER' | 'SELLER'>
  ) {
    this.assertRole(role, ...allowed);
    const orgRole = this.partyOrgRole(auth, tx, role);
    if (!orgRole || !orgRoleHas(orgRole, permission)) {
      throw DomainError.forbidden(orgRole ? `Your role (${orgRole}) does not allow this action` : undefined);
    }
  }

  /** User ids to notify for one side of the transaction. */
  async partyUserIds(tx: TransactionWithRelations, role: 'BUYER' | 'SELLER'): Promise<string[]> {
    const party = tx.parties.find((p) => p.role === role);
    const orgId = role === 'BUYER' ? tx.buyerOrganizationId : tx.sellerOrganizationId;
    const ids = new Set<string>();
    if (party?.userId) ids.add(party.userId);
    if (orgId) {
      const members = await this.prisma.organizationMember.findMany({
        where: { organizationId: orgId, role: { in: ['OWNER', 'ADMIN', 'MEMBER'] } },
        select: { userId: true },
      });
      members.forEach((m) => ids.add(m.userId));
    }
    return [...ids];
  }
}
