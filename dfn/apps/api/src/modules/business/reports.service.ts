import { Injectable } from '@nestjs/common';
import type { Prisma, TransactionStatus } from '@dfn/database';
import { Permission, minorToDecimalString, type ReportQuery } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { moneyDto } from '../../common/serialize';
import { WalletsService } from '../ledger/wallets.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  BUSINESS_DISCLAIMER_FR,
  addDays,
  clampNonNegative,
  csvLine,
  daysBetween,
  parseDay,
  startOfUtcDay,
} from './business.utils';
import { InvoicesService } from './invoices.service';

/** Transactions in which fictitious funds were actually collected (fee charged at funding). */
export const FEE_CHARGED_STATUSES: TransactionStatus[] = [
  'FUNDED',
  'IN_PROGRESS',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
];
const OPEN_INVOICE: Array<'SENT' | 'PARTIALLY_PAID' | 'OVERDUE'> = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];
export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucketFor(dueDate: Date, today: Date): AgingBucket {
  const days = daysBetween(dueDate, today);
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

interface CountAmount {
  count: number;
  amountMinor: bigint;
}

function bump(map: Map<string, CountAmount>, key: string, amountMinor: bigint) {
  const current = map.get(key) ?? { count: 0, amountMinor: 0n };
  current.count += 1;
  current.amountMinor += amountMinor;
  map.set(key, current);
}

function dtoMap(map: Map<string, CountAmount>, ccy: string) {
  return Object.fromEntries(
    [...map.entries()].map(([k, v]) => [k, { count: v.count, amount: moneyDto(v.amountMinor, ccy) }]),
  );
}

/**
 * Organisation-level reporting (Diaspora Business): Protect volumes, fees paid, receivables
 * aging, quotes pipeline, wallet balances, commissions and CSV exports. Read-only.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrganizationsService,
    private readonly wallets: WalletsService,
    private readonly invoices: InvoicesService,
  ) {}

  private period(query: ReportQuery) {
    const from = query.from ? parseDay(query.from, 'from') : undefined;
    const to = query.to ? addDays(parseDay(query.to, 'to'), 1) : undefined;
    if (from && to && from >= to) throw DomainError.validation('"from" must be before "to"');
    const range: Prisma.DateTimeFilter | undefined =
      from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;
    return { from, to, range };
  }

  async summary(auth: AuthContext, organizationId: string, query: ReportQuery) {
    this.orgs.assertMember(auth, organizationId, Permission.ORG_VIEW_REPORTS);
    const { range } = this.period(query);
    const currencyFilter = query.currencyCode ? { currencyCode: query.currencyCode } : {};
    const today = startOfUtcDay();

    const [transactions, invoices, quotes, balances] = await Promise.all([
      this.prisma.transaction.findMany({
        where: {
          OR: [{ buyerOrganizationId: organizationId }, { sellerOrganizationId: organizationId }],
          ...(range ? { createdAt: range } : {}),
          ...currencyFilter,
        },
        include: { milestones: { select: { status: true, amountMinor: true } } },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, ...(range ? { issueDate: range } : {}), ...currencyFilter },
      }),
      this.prisma.quote.findMany({
        where: { organizationId, ...(range ? { createdAt: range } : {}), ...currencyFilter },
      }),
      this.wallets.balances(auth, organizationId),
    ]);

    const currencies = new Set<string>();
    for (const t of transactions) currencies.add(t.currencyCode);
    for (const i of invoices) currencies.add(i.currencyCode);
    for (const q of quotes) currencies.add(q.currencyCode);
    if (query.currencyCode) currencies.add(query.currencyCode);
    for (const w of balances.wallets) if (w.walletId) currencies.add(w.currencyCode);
    if (currencies.size === 0) currencies.add('CAD');

    const perCurrency = [...currencies].sort().map((ccy) => {
      const txs = transactions.filter((t) => t.currencyCode === ccy);
      const asBuyer = new Map<string, CountAmount>();
      const asSeller = new Map<string, CountAmount>();
      let releasedAsBuyer = 0n;
      let receivedAsSeller = 0n;
      let refundedAsBuyer = 0n;
      let feesPaid = 0n;
      let feesCount = 0;
      for (const t of txs) {
        const released = t.milestones
          .filter((m) => m.status === 'RELEASED')
          .reduce((a, m) => a + m.amountMinor, 0n);
        const refunded = t.milestones
          .filter((m) => m.status === 'REFUNDED')
          .reduce((a, m) => a + m.amountMinor, 0n);
        if (t.buyerOrganizationId === organizationId) {
          bump(asBuyer, t.status, t.amountMinor);
          releasedAsBuyer += released;
          refundedAsBuyer += refunded;
          if (FEE_CHARGED_STATUSES.includes(t.status)) {
            feesPaid += t.feeMinor;
            feesCount += 1;
          }
        }
        if (t.sellerOrganizationId === organizationId) {
          bump(asSeller, t.status, t.amountMinor);
          receivedAsSeller += released;
        }
      }
      const buyerTotal = [...asBuyer.values()].reduce((a, v) => a + v.amountMinor, 0n);
      const sellerTotal = [...asSeller.values()].reduce((a, v) => a + v.amountMinor, 0n);

      const invs = invoices.filter((i) => i.currencyCode === ccy);
      const byStatus = new Map<string, CountAmount>();
      const aging = new Map<AgingBucket, CountAmount>(
        AGING_BUCKETS.map((b) => [b, { count: 0, amountMinor: 0n }]),
      );
      let outstanding = 0n;
      let outstandingCount = 0;
      let invoiced = 0n;
      let collected = 0n;
      let overdueCount = 0;
      for (const inv of invs) {
        bump(byStatus, inv.status, inv.totalMinor);
        if (inv.status !== 'CANCELLED') {
          invoiced += inv.totalMinor;
          collected += inv.paidMinor;
        }
        if (OPEN_INVOICE.includes(inv.status as (typeof OPEN_INVOICE)[number])) {
          const balance = clampNonNegative(inv.totalMinor - inv.paidMinor);
          outstanding += balance;
          outstandingCount += 1;
          if (inv.status === 'OVERDUE') overdueCount += 1;
          bump(aging, agingBucketFor(inv.dueDate, today), balance);
        }
      }

      const qs = quotes.filter((q) => q.currencyCode === ccy);
      const pipeline = new Map<string, CountAmount>();
      let openValue = 0n;
      for (const q of qs) {
        bump(pipeline, q.status, q.totalMinor);
        if (q.status === 'SENT' || q.status === 'ACCEPTED') openValue += q.totalMinor;
      }

      const wallet = balances.wallets.find((w) => w.currencyCode === ccy);
      return {
        currencyCode: ccy,
        protect: {
          asBuyer: {
            byStatus: dtoMap(asBuyer, ccy),
            count: txs.filter((t) => t.buyerOrganizationId === organizationId).length,
            amount: moneyDto(buyerTotal, ccy),
          },
          asSeller: {
            byStatus: dtoMap(asSeller, ccy),
            count: txs.filter((t) => t.sellerOrganizationId === organizationId).length,
            amount: moneyDto(sellerTotal, ccy),
          },
          releasedAsBuyer: moneyDto(releasedAsBuyer, ccy),
          refundedAsBuyer: moneyDto(refundedAsBuyer, ccy),
          receivedAsSeller: moneyDto(receivedAsSeller, ccy),
          feesPaid: moneyDto(feesPaid, ccy),
          feesCount,
        },
        receivables: {
          count: invs.length,
          invoiced: moneyDto(invoiced, ccy),
          collected: moneyDto(collected, ccy),
          outstanding: moneyDto(outstanding, ccy),
          outstandingCount,
          overdueCount,
          byStatus: dtoMap(byStatus, ccy),
          aging: Object.fromEntries(
            AGING_BUCKETS.map((b) => {
              const v = aging.get(b)!;
              return [b, { count: v.count, amount: moneyDto(v.amountMinor, ccy) }];
            }),
          ),
        },
        quotes: {
          count: qs.length,
          pipeline: dtoMap(pipeline, ccy),
          openValue: moneyDto(openValue, ccy),
        },
        wallet: wallet
          ? { walletId: wallet.walletId, balance: wallet.balance, entryCount: wallet.entryCount }
          : null,
      };
    });

    const quotesPipeline: Record<string, number> = {};
    for (const q of quotes) quotesPipeline[q.status] = (quotesPipeline[q.status] ?? 0) + 1;

    return {
      organizationId,
      period: { from: query.from ?? null, to: query.to ?? null },
      generatedAt: new Date(),
      currencies: perCurrency,
      quotesPipeline,
      counts: { transactions: transactions.length, invoices: invoices.length, quotes: quotes.length },
      links: {
        transactionsCsv: `/v1/organizations/${organizationId}/reports/transactions.csv`,
        invoicesCsv: `/v1/organizations/${organizationId}/reports/invoices.csv`,
        commissions: `/v1/organizations/${organizationId}/reports/commissions`,
      },
      sandbox: true,
      disclaimer: BUSINESS_DISCLAIMER_FR,
    };
  }

  static readonly TRANSACTIONS_CSV_HEADER =
    'reference,title,role,status,currency,amount,fee,fee_bps,released,refunded,counterpart,origin_country,destination_country,created_at,funded_at,settled_at';

  async transactionsCsv(auth: AuthContext, organizationId: string, query: ReportQuery) {
    this.orgs.assertMember(auth, organizationId, Permission.ORG_VIEW_REPORTS);
    const { range } = this.period(query);
    const txs = await this.prisma.transaction.findMany({
      where: {
        OR: [{ buyerOrganizationId: organizationId }, { sellerOrganizationId: organizationId }],
        ...(range ? { createdAt: range } : {}),
        ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
      },
      include: {
        milestones: { select: { status: true, amountMinor: true } },
        parties: { include: { organization: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const rows = txs.map((t) => {
      const role = t.buyerOrganizationId === organizationId ? 'BUYER' : 'SELLER';
      const counterpart = t.parties.find((p) => p.role === (role === 'BUYER' ? 'SELLER' : 'BUYER'));
      const released = t.milestones
        .filter((m) => m.status === 'RELEASED')
        .reduce((a, m) => a + m.amountMinor, 0n);
      const refunded = t.milestones
        .filter((m) => m.status === 'REFUNDED')
        .reduce((a, m) => a + m.amountMinor, 0n);
      return csvLine([
        t.reference,
        t.title,
        role,
        t.status,
        t.currencyCode,
        minorToDecimalString(t.amountMinor, t.currencyCode),
        role === 'BUYER' ? minorToDecimalString(t.feeMinor, t.currencyCode) : '0',
        t.feeBps,
        minorToDecimalString(released, t.currencyCode),
        minorToDecimalString(refunded, t.currencyCode),
        counterpart?.organization?.name ?? counterpart?.invitedName ?? counterpart?.invitedEmail ?? '',
        t.originCountry,
        t.destinationCountry,
        t.createdAt.toISOString(),
        t.fundedAt?.toISOString() ?? '',
        t.settledAt?.toISOString() ?? '',
      ]);
    });
    return [
      `# Diaspora Trust — SANDBOX Protect transactions. ${BUSINESS_DISCLAIMER_FR}`,
      ReportsService.TRANSACTIONS_CSV_HEADER,
      ...rows,
    ].join('\n');
  }

  async invoicesCsv(auth: AuthContext, organizationId: string) {
    this.orgs.assertMember(auth, organizationId, Permission.ORG_VIEW_REPORTS);
    return this.invoices.csv(auth, organizationId);
  }

  /** Platform commissions charged to the organisation as a buyer, one line per funded transaction. */
  async commissions(auth: AuthContext, organizationId: string, query: ReportQuery) {
    this.orgs.assertMember(auth, organizationId, Permission.ORG_VIEW_REPORTS);
    const { range } = this.period(query);
    const txs = await this.prisma.transaction.findMany({
      where: {
        buyerOrganizationId: organizationId,
        status: { in: FEE_CHARGED_STATUSES },
        ...(range ? { fundedAt: range } : {}),
        ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
      },
      orderBy: { fundedAt: 'desc' },
    });
    const fundings = await this.prisma.ledgerTransaction.findMany({
      where: { kind: 'FUNDING', reference: { in: txs.map((t) => t.id) } },
      select: { id: true, reference: true, postedAt: true },
    });
    const fundingByTx = new Map(fundings.map((f) => [f.reference!, f]));
    const totals = new Map<string, CountAmount>();
    const items = txs.map((t) => {
      bump(totals, t.currencyCode, t.feeMinor);
      const funding = fundingByTx.get(t.id);
      return {
        transactionId: t.id,
        reference: t.reference,
        title: t.title,
        status: t.status,
        currencyCode: t.currencyCode,
        amount: moneyDto(t.amountMinor, t.currencyCode),
        fee: moneyDto(t.feeMinor, t.currencyCode),
        feeBps: t.feeBps,
        fundedAt: t.fundedAt,
        ledgerTransactionId: funding?.id ?? null,
        postedAt: funding?.postedAt ?? null,
        simulated: true,
      };
    });
    return {
      organizationId,
      period: { from: query.from ?? null, to: query.to ?? null },
      currencies: [...totals.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ccy, v]) => ({ currencyCode: ccy, count: v.count, totalFees: moneyDto(v.amountMinor, ccy) })),
      items,
      sandbox: true,
      disclaimer: BUSINESS_DISCLAIMER_FR,
    };
  }
}
