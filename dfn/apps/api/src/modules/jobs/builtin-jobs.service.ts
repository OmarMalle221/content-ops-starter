import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LedgerService } from '@dfn/financial-ledger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { LEDGER } from '../ledger/ledger.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { TransactionsService } from '../transactions/transactions.service';
import { anonymizationCutoff } from './anonymization';
import { AnonymizationService } from './anonymization.service';
import { JobRegistry, type JobResult } from './job-registry';

/**
 * Platform-level maintenance jobs. Feature modules (transfers, api-platform, business) register
 * TRANSFER_PROCESSING, WEBHOOK_RETRY and INVOICE_OVERDUE on the same registry themselves.
 */
@Injectable()
export class BuiltinJobsService implements OnModuleInit {
  private readonly logger = new Logger(BuiltinJobsService.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly transactions: TransactionsService,
    private readonly anonymization: AnonymizationService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.registry.register('BALANCE_SNAPSHOTS', () => this.balanceSnapshots());
    this.registry.register('RECONCILIATION', () => this.reconciliation());
    this.registry.register('EXPIRE_STALE', () => this.expireStale());
    this.registry.register('ANONYMIZE_DELETED', (ctx) => this.anonymizeDeleted(ctx.triggeredBy));
  }

  /** One BalanceSnapshot per ACTIVE ledger account — the anchor used by the reconciliation. */
  async balanceSnapshots(): Promise<JobResult> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      orderBy: { code: 'asc' },
    });
    for (const account of accounts) await this.ledger.snapshot(account.id);
    return { summary: { accounts: accounts.length } };
  }

  /** Full ledger reconciliation; staff is notified when anything does not add up. */
  async reconciliation(): Promise<JobResult> {
    const result = await this.ledger.reconcile();
    const differences = result.differences.length;
    const unbalancedTransactions = result.unbalancedTransactions.length;
    let notified = 0;
    if (differences > 0 || unbalancedTransactions > 0) {
      const staff = await this.prisma.user.findMany({
        where: { status: 'ACTIVE', deletedAt: null, globalRole: { in: ['ADMIN', 'COMPLIANCE'] } },
        select: { id: true },
      });
      await this.notifications.notifyMany(
        staff.map((u) => u.id),
        {
          type: 'ledger.reconciliation_anomalies',
          title: 'Réconciliation du registre — anomalies détectées',
          body:
            `La réconciliation ${result.jobId} a relevé ${differences} écart(s) de solde et ` +
            `${unbalancedTransactions} écriture(s) non équilibrée(s) sur ${result.accountsChecked} compte(s). ` +
            'Données fictives — Aucun fonds réel.',
          data: { jobId: result.jobId, differences, unbalancedTransactions },
        },
      );
      notified = staff.length;
      this.logger.warn(
        `reconciliation ${result.jobId}: ${differences} differences, ${unbalancedTransactions} unbalanced — ${notified} staff notified`,
      );
    }
    return {
      summary: {
        jobId: result.jobId,
        accountsChecked: result.accountsChecked,
        differences,
        unbalancedTransactions,
        notified,
      },
    };
  }

  /** Expires stale Protect transactions / funding requests and FX quotes past their validity. */
  async expireStale(): Promise<JobResult> {
    const now = new Date();
    const transactions = await this.transactions.expireStale();
    const quotes = await this.prisma.fXQuote.updateMany({
      where: { status: 'QUOTED', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    return { summary: { transactionsExpired: transactions.expired, fxQuotesExpired: quotes.count } };
  }

  /** Anonymises every user whose deletion grace period (ANONYMIZE_AFTER_DAYS) has elapsed. */
  async anonymizeDeleted(triggeredBy: string): Promise<JobResult> {
    const afterDays = this.env.ANONYMIZE_AFTER_DAYS;
    const cutoff = anonymizationCutoff(new Date(), afterDays);
    const due = await this.prisma.user.findMany({
      where: { deletionRequestedAt: { not: null, lte: cutoff }, anonymizedAt: null },
      select: { id: true },
      orderBy: { deletionRequestedAt: 'asc' },
    });
    let anonymized = 0;
    const failed: string[] = [];
    for (const user of due) {
      try {
        await this.anonymization.anonymizeUser(user.id, triggeredBy);
        anonymized++;
      } catch (err) {
        failed.push(user.id);
        this.logger.error(
          `anonymisation of ${user.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      summary: { afterDays, due: due.length, anonymized, failed: failed.length, failedUserIds: failed },
    };
  }
}
