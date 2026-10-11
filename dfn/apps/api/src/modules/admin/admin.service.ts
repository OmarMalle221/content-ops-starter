import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '@dfn/database';
import { LedgerService } from '@dfn/financial-ledger';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { LEDGER } from '../ledger/ledger.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { TransactionsService } from '../transactions/transactions.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
    private readonly transactions: TransactionsService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
  ) {}

  async stats() {
    const [
      users,
      organizations,
      transactionsByStatus,
      openDisputes,
      openAlerts,
      pendingVerifications,
      volume,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.organization.count({ where: { deletedAt: null } }),
      this.prisma.transaction.groupBy({ by: ['status'], _count: true }),
      this.prisma.dispute.count({ where: { status: { not: 'CLOSED' } } }),
      this.prisma.riskAlert.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
      this.prisma.identityVerification.count({ where: { status: 'PENDING' } }),
      this.prisma.transaction.groupBy({
        by: ['currencyCode'],
        where: { status: { in: ['FUNDED', 'IN_PROGRESS', 'DISPUTED', 'SETTLED'] } },
        _sum: { amountMinor: true, feeMinor: true },
        _count: true,
      }),
    ]);
    return {
      sandbox: true,
      users,
      organizations,
      transactions: Object.fromEntries(transactionsByStatus.map((t) => [t.status, t._count])),
      openDisputes,
      openRiskAlerts: openAlerts,
      pendingVerifications,
      volumeByCurrency: volume.map((v) => ({
        currency: v.currencyCode,
        count: v._count,
        amountMinor: (v._sum.amountMinor ?? 0n).toString(),
        feeMinor: (v._sum.feeMinor ?? 0n).toString(),
      })),
    };
  }

  async listUsers(page: number, pageSize: number, search?: string) {
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          country: true,
          globalRole: true,
          status: true,
          mfaEnabled: true,
          createdAt: true,
          lastLoginAt: true,
          identityVerifications: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
          _count: { select: { memberships: true, riskAlerts: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: items.map((u) => ({
        ...u,
        identityStatus: u.identityVerifications[0]?.status ?? 'NOT_STARTED',
        identityVerifications: undefined,
      })),
      total,
      page,
      pageSize,
    };
  }

  async updateUserStatus(
    auth: AuthContext,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED',
    reason: string,
    req: Request,
  ) {
    if (userId === auth.userId) throw DomainError.validation('You cannot change your own status');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw DomainError.notFound('User');
    await this.prisma.$transaction(async (db) => {
      await db.user.update({ where: { id: userId }, data: { status } });
      if (status !== 'ACTIVE')
        await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'admin.user_status_changed',
          entityType: 'User',
          entityId: userId,
          metadata: { from: user.status, to: status, reason },
          ...requestMeta(req),
        },
        db,
      );
    });
    return { id: userId, status };
  }

  async updateUserRole(
    auth: AuthContext,
    userId: string,
    globalRole: 'USER' | 'COMPLIANCE' | 'ADMIN',
    req: Request,
  ) {
    if (userId === auth.userId) throw DomainError.validation('You cannot change your own role');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw DomainError.notFound('User');
    await this.prisma.user.update({ where: { id: userId }, data: { globalRole } });
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.user_role_changed',
      entityType: 'User',
      entityId: userId,
      metadata: { from: user.globalRole, to: globalRole },
      ...requestMeta(req),
    });
    return { id: userId, globalRole };
  }

  async listRiskAlerts(status: string | undefined, page: number, pageSize: number) {
    const where: Prisma.RiskAlertWhereInput = status ? { status: status as any } : {};
    const [items, total] = await Promise.all([
      this.prisma.riskAlert.findMany({
        where,
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
          transaction: { select: { id: true, reference: true, title: true } },
          actions: {
            orderBy: { createdAt: 'asc' },
            include: { actor: { select: { firstName: true, lastName: true } } },
          },
        },
      }),
      this.prisma.riskAlert.count({ where }),
    ]);
    return { items, total, page, pageSize, rules: this.risk.listRules() };
  }

  async actOnRiskAlert(
    auth: AuthContext,
    id: string,
    action: 'START_REVIEW' | 'CONFIRM' | 'DISMISS' | 'CONTEST',
    note: string,
    req: Request,
  ) {
    const alert = await this.prisma.riskAlert.findUnique({ where: { id } });
    if (!alert) throw DomainError.notFound('Risk alert');
    const next = {
      START_REVIEW: 'REVIEWING',
      CONFIRM: 'CONFIRMED',
      DISMISS: 'DISMISSED',
      CONTEST: 'CONTESTED',
    } as const;
    const updated = await this.prisma.$transaction(async (db) => {
      const u = await db.riskAlert.update({
        where: { id },
        data: {
          status: next[action],
          resolvedById: action === 'START_REVIEW' ? null : auth.userId,
          resolutionNote: action === 'START_REVIEW' ? null : note,
          resolvedAt: action === 'START_REVIEW' ? null : new Date(),
        },
      });
      await db.riskAlertAction.create({ data: { alertId: id, actorUserId: auth.userId, action, note } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'admin.risk_alert_action',
          entityType: 'RiskAlert',
          entityId: id,
          metadata: { action, from: alert.status, to: next[action] },
          ...requestMeta(req),
        },
        db,
      );
      return u;
    });
    if (alert.userId && action !== 'START_REVIEW') {
      await this.notifications.notify({
        userId: alert.userId,
        type: 'risk.alert_resolved',
        title: 'Revue de conformité',
        body: `Une alerte sur votre compte a été traitée (${next[action]}). Vous pouvez contester cette décision via le support.`,
        data: { alertId: id },
      });
    }
    return updated;
  }

  async ledgerOverview(page: number, pageSize: number) {
    const [accounts, transactions, total, jobs] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.ledgerTransaction.findMany({
        orderBy: { postedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { entries: { include: { account: { select: { code: true } } } } },
      }),
      this.prisma.ledgerTransaction.count(),
      this.prisma.reconciliationJob.findMany({
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: { differences: true },
      }),
    ]);
    const balances = await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: (await this.ledger.getBalance(a.id)).balanceMinor.toString(),
      })),
    );
    return {
      accounts: balances,
      transactions: { items: transactions, total, page, pageSize },
      reconciliations: jobs,
    };
  }

  async reconcile(auth: AuthContext, req: Request) {
    const result = await this.ledger.reconcile();
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.ledger_reconciled',
      entityType: 'ReconciliationJob',
      entityId: result.jobId,
      metadata: {
        accountsChecked: result.accountsChecked,
        differences: result.differences.length,
        unbalanced: result.unbalancedTransactions.length,
      },
      ...requestMeta(req),
    });
    return result;
  }

  async listTransactions(page: number, pageSize: number, status?: string) {
    const where: Prisma.TransactionWhereInput = status ? { status: status as any } : {};
    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          buyerOrganization: { select: { name: true } },
          sellerOrganization: { select: { name: true } },
          _count: { select: { disputes: true, riskAlerts: true } },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async runMaintenance(auth: AuthContext, req: Request) {
    const result = await this.transactions.expireStale();
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.maintenance_run',
      entityType: 'System',
      metadata: result,
      ...requestMeta(req),
    });
    return result;
  }
}
