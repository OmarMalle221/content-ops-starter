import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { InvoiceStatus, QuoteStatus, TransactionStatus, TransferStatus } from '@dfn/database';
import { LedgerService } from '@dfn/financial-ledger';
import type { DeleteAccountInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { LoginAttemptsService } from '../auth/login-attempts.service';
import { SessionService } from '../auth/session.service';
import { LEDGER } from '../ledger/ledger.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { anonymizeAfter } from './anonymization';

/** A transaction in one of these states no longer binds its parties. */
export const CLOSED_TRANSACTION_STATES: TransactionStatus[] = ['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'];
/** A transfer in one of these states still awaits a decision or moves (fictitious) funds. */
export const OPEN_TRANSFER_STATES: TransferStatus[] = [
  'QUOTED',
  'REVIEW_REQUIRED',
  'AUTHORIZED',
  'PROCESSING',
];
/** Invoices / quotes a customer may still act on. */
export const OPEN_INVOICE_STATES: InvoiceStatus[] = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];
export const OPEN_QUOTE_STATES: QuoteStatus[] = ['SENT'];

export interface DeletionBlockers {
  /** Transactions (as buyer, seller or creator) that are not SETTLED/REFUNDED/CANCELLED/EXPIRED. */
  openTransactions: number;
  /** BUSINESS organisations where the user is the only OWNER and other members remain. */
  soleOwnerOrganizations: number;
  /** Wallets of the PERSONAL organisation holding a non-zero (fictitious) balance. */
  walletsWithBalance: number;
  /** Transfers the user created, or of their PERSONAL organisation, still QUOTED/REVIEW_REQUIRED/AUTHORIZED/PROCESSING. */
  openTransfers: number;
  /** Invoices of the PERSONAL organisation that are SENT, PARTIALLY_PAID or OVERDUE. */
  openInvoices: number;
  /** Quotes of the PERSONAL organisation that are SENT. */
  openQuotes: number;
  /** API keys the user created that are neither revoked nor expired. */
  activeApiCredentials: number;
  /** BUSINESS organisations where the user is the only member and a wallet holds a non-zero balance. */
  soleMemberOrganizationsWithBalance: number;
}

export function hasBlockers(b: DeletionBlockers): boolean {
  return Object.values(b).some((count) => count > 0);
}

/**
 * Self-service account deletion: the request deactivates the account immediately and revokes
 * every session; the ANONYMIZE_DELETED job anonymises the row once ANONYMIZE_AFTER_DAYS have
 * elapsed, which leaves staff a window to cancel (POST /v1/admin/users/:id/deletion-cancel).
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly sessions: SessionService,
    private readonly loginAttempts: LoginAttemptsService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async blockers(userId: string): Promise<DeletionBlockers> {
    const personalOrganization = { type: 'PERSONAL' as const, members: { some: { userId } } };
    const [
      openTransactions,
      openTransfers,
      openInvoices,
      openQuotes,
      activeApiCredentials,
      businessMemberships,
      personalWallets,
    ] = await Promise.all([
      this.prisma.transaction.count({
        where: {
          status: { notIn: CLOSED_TRANSACTION_STATES },
          OR: [{ createdByUserId: userId }, { parties: { some: { userId } } }],
        },
      }),
      // In-flight transfers the user is responsible for: the ones they created (also through an API
      // key, which impersonates its creator) and every one of their PERSONAL organisation.
      this.prisma.transfer.count({
        where: {
          status: { in: OPEN_TRANSFER_STATES },
          OR: [{ createdByUserId: userId }, { organization: personalOrganization }],
        },
      }),
      this.prisma.invoice.count({
        where: { status: { in: OPEN_INVOICE_STATES }, organization: personalOrganization },
      }),
      this.prisma.quote.count({
        where: { status: { in: OPEN_QUOTE_STATES }, organization: personalOrganization },
      }),
      this.prisma.apiCredential.count({
        where: {
          createdByUserId: userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          organization: { deletedAt: null },
        },
      }),
      this.prisma.organizationMember.findMany({
        where: { userId, organization: { type: 'BUSINESS', deletedAt: null } },
        include: {
          organization: {
            include: {
              members: { select: { userId: true, role: true } },
              wallets: { select: { ledgerAccountId: true } },
            },
          },
        },
      }),
      this.prisma.wallet.findMany({
        where: { organization: personalOrganization },
        select: { ledgerAccountId: true },
      }),
    ]);
    // A BUSINESS organisation blocks the deletion when it would be left without an owner (other
    // members remain but none is an OWNER) or when nobody else could ever empty its wallets (the
    // user is its only member and a balance remains).
    let soleOwnerOrganizations = 0;
    let soleMemberOrganizationsWithBalance = 0;
    for (const m of businessMemberships) {
      const others = m.organization.members.filter((member) => member.userId !== userId);
      if (others.length > 0) {
        if (m.role === 'OWNER' && !others.some((member) => member.role === 'OWNER')) soleOwnerOrganizations++;
      } else if ((await this.countWalletsWithBalance(m.organization.wallets)) > 0) {
        soleMemberOrganizationsWithBalance++;
      }
    }
    const walletsWithBalance = await this.countWalletsWithBalance(personalWallets);
    return {
      openTransactions,
      soleOwnerOrganizations,
      walletsWithBalance,
      openTransfers,
      openInvoices,
      openQuotes,
      activeApiCredentials,
      soleMemberOrganizationsWithBalance,
    };
  }

  private async countWalletsWithBalance(wallets: Array<{ ledgerAccountId: string }>): Promise<number> {
    let count = 0;
    for (const wallet of wallets) {
      const balance = await this.ledger.getBalance(wallet.ledgerAccountId);
      if (balance.balanceMinor !== 0n) count++;
    }
    return count;
  }

  async status(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { deletionRequestedAt: true, anonymizedAt: true },
    });
    const blockers = await this.blockers(userId);
    return {
      sandbox: true,
      deletionRequestedAt: user.deletionRequestedAt,
      anonymizedAt: user.anonymizedAt,
      anonymizeAfterDays: this.env.ANONYMIZE_AFTER_DAYS,
      anonymizeAfter: anonymizeAfter(user.deletionRequestedAt, this.env.ANONYMIZE_AFTER_DAYS),
      blockers,
      canRequest: !user.deletionRequestedAt && !hasBlockers(blockers),
    };
  }

  async request(auth: AuthContext, input: DeleteAccountInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    // Counted in the login lockout like every other password confirmation (423 once locked).
    if (!(await this.loginAttempts.verifyPassword(user, input.password)).ok) {
      throw DomainError.validation('Current password is incorrect');
    }
    if (user.deletionRequestedAt) {
      throw new DomainError(
        'DELETION_ALREADY_REQUESTED',
        'Account deletion has already been requested',
        HttpStatus.CONFLICT,
        { deletionRequestedAt: user.deletionRequestedAt },
      );
    }
    const blockers = await this.blockers(user.id);
    if (hasBlockers(blockers)) {
      throw new DomainError(
        'ACCOUNT_HAS_OPEN_ITEMS',
        'Your account still has open transactions, transfers, invoices, API keys, organisations or balances; settle them before requesting deletion',
        HttpStatus.CONFLICT,
        blockers,
      );
    }
    const now = new Date();
    const afterDays = this.env.ANONYMIZE_AFTER_DAYS;
    const scheduledFor = anonymizeAfter(now, afterDays)!;
    await this.prisma.$transaction(async (db) => {
      await db.user.update({
        where: { id: user.id },
        data: { deletionRequestedAt: now, status: 'DEACTIVATED' },
      });
      await this.audit.log(
        {
          actorUserId: user.id,
          action: 'user.deletion_requested',
          entityType: 'User',
          entityId: user.id,
          metadata: {
            reason: input.reason ?? null,
            anonymizeAfterDays: afterDays,
            anonymizeAfter: scheduledFor.toISOString(),
          },
          ...requestMeta(req),
        },
        db,
      );
      await this.notifications.notify(
        {
          userId: user.id,
          type: 'account.deletion_requested',
          title: 'Demande de suppression de compte enregistrée',
          body:
            `Votre compte est désactivé immédiatement et vos données personnelles seront anonymisées ` +
            `dans ${afterDays} jour(s). L’équipe peut annuler la demande pendant ce délai. ` +
            'Données fictives — Aucun fonds réel.',
          data: { anonymizeAfter: scheduledFor.toISOString(), anonymizeAfterDays: afterDays },
        },
        db,
      );
    });
    await this.sessions.revokeAllForUser(user.id);
    return {
      sandbox: true,
      status: 'DEACTIVATED' as const,
      deletionRequestedAt: now,
      anonymizeAfterDays: afterDays,
      anonymizeAfter: scheduledFor,
    };
  }

  async adminCancel(auth: AuthContext, userId: string, req: Request) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw DomainError.notFound('User');
    if (user.anonymizedAt) {
      throw new DomainError(
        'ACCOUNT_ALREADY_ANONYMIZED',
        'This account has already been anonymised and cannot be restored',
        HttpStatus.CONFLICT,
        { anonymizedAt: user.anonymizedAt },
      );
    }
    const requestedAt = user.deletionRequestedAt;
    if (!requestedAt) {
      throw new DomainError(
        'NO_DELETION_REQUEST',
        'This account has no pending deletion request',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (db) => {
      await db.user.update({
        where: { id: userId },
        data: { deletionRequestedAt: null, status: 'ACTIVE' },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'admin.user_deletion_cancelled',
          entityType: 'User',
          entityId: userId,
          metadata: { deletionRequestedAt: requestedAt.toISOString(), from: user.status },
          ...requestMeta(req),
        },
        db,
      );
      await this.notifications.notify(
        {
          userId,
          type: 'account.deletion_cancelled',
          title: 'Demande de suppression annulée',
          body: 'Votre demande de suppression a été annulée par l’équipe et votre compte est de nouveau actif.',
        },
        db,
      );
    });
    return { id: userId, status: 'ACTIVE' as const, deletionRequestedAt: null };
  }
}
