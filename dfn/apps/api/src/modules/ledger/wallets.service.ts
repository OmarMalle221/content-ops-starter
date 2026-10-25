import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Prisma, PrismaTransactionClient } from '@dfn/database';
import { LedgerService, providerSettlementCode, walletAccountCode } from '@dfn/financial-ledger';
import {
  SANDBOX_PROVIDER_CODE,
  convertMinor,
  createFxRateProvider,
  quoteTransferFee,
  type FxRateProvider,
} from '@dfn/payment-adapters';
import {
  CURRENCIES,
  Permission,
  getCurrency,
  minorToDecimalString,
  orgRoleHas,
  parseDecimalToMinor,
  type ConversionEstimateInput,
  type SandboxSelfDepositInput,
  type WalletEntriesQuery,
} from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { moneyDto } from '../../common/serialize';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { LEDGER } from './ledger.provider';

export const SANDBOX_DISCLAIMER_FR = 'Données fictives — Aucun fonds réel';

/** Optional filters of the wallet operations list. */
export type WalletEntriesFilter = Pick<WalletEntriesQuery, 'kind' | 'status' | 'from' | 'to'>;

/** Parses a YYYY-MM-DD day (inclusive) or an ISO timestamp into a Date boundary. */
function parseDateBoundary(value: string | undefined, end: boolean): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw DomainError.validation(`Invalid date: ${value}`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw DomainError.validation(`Invalid date: ${value}`);
  return d;
}

/**
 * The daily self-deposit limit is configured once as a nominal decimal ("50000.00") and applied
 * to every currency, so it is re-scaled to the currency exponent before parsing.
 */
export function selfDepositLimitMinor(limit: string, currencyCode: string): bigint {
  const { exponent } = getCurrency(currencyCode);
  const [whole, frac = ''] = limit.trim().replace(',', '.').split('.');
  const scaledFrac = frac.slice(0, exponent).padEnd(exponent, '0');
  return parseDecimalToMinor(exponent === 0 ? whole : `${whole}.${scaledFrac}`, currencyCode);
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);
  private readonly fx: FxRateProvider;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
    private readonly risk: RiskService,
  ) {
    this.fx = createFxRateProvider(env.FX_PROVIDER);
  }

  /** Wallet balances are never stored: they are derived from the ledger account. */
  async ensureWallet(
    organizationId: string,
    currencyCode: string,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    const existing = await db.wallet.findUnique({
      where: { organizationId_currencyCode: { organizationId, currencyCode } },
    });
    if (existing) return existing;
    const account = await this.ledger.ensureAccount(
      {
        code: walletAccountCode(organizationId, currencyCode),
        name: `Wallet ${organizationId} (${currencyCode})`,
        type: 'LIABILITY',
        normalBalance: 'CREDIT',
        currencyCode,
        ownerType: 'ORGANIZATION',
        ownerId: organizationId,
      },
      db,
    );
    // Concurrency-safe: a parallel first use of the same wallet must not fail with a unique
    // violation (which would also abort an enclosing transaction).
    await db.wallet.createMany({
      data: [{ organizationId, currencyCode, ledgerAccountId: account.id }],
      skipDuplicates: true,
    });
    return db.wallet.findUniqueOrThrow({
      where: { organizationId_currencyCode: { organizationId, currencyCode } },
    });
  }

  private assertAccess(auth: AuthContext, organizationId: string) {
    if (isStaff(auth)) return;
    if (!membershipFor(auth, organizationId)) throw DomainError.notFound('Organization');
  }

  async balances(auth: AuthContext, organizationId: string) {
    this.assertAccess(auth, organizationId);
    const wallets = await this.prisma.wallet.findMany({ where: { organizationId } });
    const byCurrency = new Map(wallets.map((w) => [w.currencyCode, w]));
    const result = [];
    for (const code of Object.keys(CURRENCIES)) {
      const wallet = byCurrency.get(code);
      if (!wallet) {
        result.push({
          currencyCode: code,
          walletId: null,
          balance: { minor: '0', decimal: minorToDecimalString(0n, code), currency: code },
          entryCount: 0,
        });
        continue;
      }
      const b = await this.ledger.getBalance(wallet.ledgerAccountId);
      result.push({
        currencyCode: code,
        walletId: wallet.id,
        balance: {
          minor: b.balanceMinor.toString(),
          decimal: minorToDecimalString(b.balanceMinor, code),
          currency: code,
        },
        entryCount: b.entryCount,
      });
    }
    return {
      organizationId,
      simulated: true,
      disclaimer: SANDBOX_DISCLAIMER_FR,
      wallets: result,
    };
  }

  private entriesWhere(accountId: string, filter: WalletEntriesFilter): Prisma.LedgerEntryWhereInput {
    const from = parseDateBoundary(filter.from, false);
    const to = parseDateBoundary(filter.to, true);
    if (from && to && from > to) throw DomainError.validation('"from" must be before "to"');
    const txWhere: Prisma.LedgerTransactionWhereInput = {};
    if (filter.kind) txWhere.kind = filter.kind;
    if (filter.status) txWhere.status = filter.status;
    if (from || to) txWhere.postedAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
    return { accountId, ...(Object.keys(txWhere).length ? { ledgerTransaction: txWhere } : {}) };
  }

  async entries(
    auth: AuthContext,
    organizationId: string,
    currencyCode: string,
    page: number,
    pageSize: number,
    filter: WalletEntriesFilter = {},
  ) {
    this.assertAccess(auth, organizationId);
    const wallet = await this.prisma.wallet.findUnique({
      where: { organizationId_currencyCode: { organizationId, currencyCode } },
    });
    if (!wallet) return { items: [], total: 0, page, pageSize };
    const where = this.entriesWhere(wallet.ledgerAccountId, filter);
    const [items, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { ledgerTransaction: true },
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
    return {
      items: items.map((e) => ({
        id: e.id,
        direction: e.direction,
        // From the wallet owner's point of view a CREDIT increases the balance.
        signedAmount: {
          minor: (e.direction === 'CREDIT' ? e.amountMinor : -e.amountMinor).toString(),
          decimal: minorToDecimalString(
            e.direction === 'CREDIT' ? e.amountMinor : -e.amountMinor,
            currencyCode,
          ),
          currency: currencyCode,
        },
        kind: e.ledgerTransaction.kind,
        description: e.ledgerTransaction.description,
        reference: e.ledgerTransaction.reference,
        status: e.ledgerTransaction.status,
        postedAt: e.ledgerTransaction.postedAt,
        ledgerTransactionId: e.ledgerTransactionId,
      })),
      total,
      page,
      pageSize,
    };
  }

  async statementCsv(
    auth: AuthContext,
    organizationId: string,
    currencyCode: string,
    filter: WalletEntriesFilter = {},
  ) {
    const all = await this.entries(auth, organizationId, currencyCode, 1, 100, filter);
    const header = 'posted_at,kind,description,reference,signed_amount,currency,status,ledger_transaction_id';
    const rows = all.items.map((i) =>
      [
        i.postedAt.toISOString(),
        i.kind,
        JSON.stringify(i.description),
        i.reference ?? '',
        i.signedAmount.decimal,
        currencyCode,
        i.status,
        i.ledgerTransactionId,
      ].join(','),
    );
    return [`# Diaspora Trust — SANDBOX statement. ${SANDBOX_DISCLAIMER_FR}`, header, ...rows].join('\n');
  }

  /** Statement links are relative API paths so the web proxy can prefix them. */
  private statementPath(organizationId: string, currencyCode: string) {
    return `/v1/wallets/${organizationId}/${currencyCode}/statement.csv`;
  }

  /** Daily sandbox self-deposit usage for one organisation + currency (UTC day). */
  async selfDepositUsage(
    organizationId: string,
    currencyCode: string,
    walletAccountId: string | null,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    const limitMinor = selfDepositLimitMinor(this.env.SANDBOX_SELF_DEPOSIT_DAILY_LIMIT, currencyCode);
    let usedMinor = 0n;
    if (walletAccountId) {
      // One aggregate over today's self-service deposits credited to this wallet (constant cost,
      // whatever the number of deposits of the day).
      const [row] = await db.$queryRaw<Array<{ used: bigint | null }>>`
        SELECT COALESCE(SUM(e."amountMinor"), 0)::bigint AS used
        FROM "LedgerEntry" e
        JOIN "LedgerTransaction" t ON t.id = e."ledgerTransactionId"
        WHERE e."accountId" = ${walletAccountId}::uuid
          AND e.direction = 'CREDIT'
          AND t.kind = 'DEPOSIT'
          AND t.status = 'POSTED'
          AND t.reference = ${organizationId}
          AND t."postedAt" >= ${startOfUtcDay()}
          AND t.metadata ->> 'selfService' = 'true'
          AND t.metadata ->> 'currencyCode' = ${currencyCode}`;
      usedMinor = BigInt(row?.used ?? 0);
    }
    const remainingMinor = limitMinor - usedMinor > 0n ? limitMinor - usedMinor : 0n;
    return {
      limit: moneyDto(limitMinor, currencyCode)!,
      usedToday: moneyDto(usedMinor, currencyCode)!,
      remaining: moneyDto(remainingMinor, currencyCode)!,
      limitMinor,
      usedMinor,
      remainingMinor,
    };
  }

  /**
   * One-call overview for the wallet screen: every currency balance with its latest operations,
   * pending Protect items and statement links. Read-only.
   */
  async summary(auth: AuthContext, organizationId: string) {
    this.assertAccess(auth, organizationId);
    const [balances, wallets, awaitingFundingAsBuyer, escrowsHoldingAsSeller] = await Promise.all([
      this.balances(auth, organizationId),
      this.prisma.wallet.findMany({ where: { organizationId } }),
      this.prisma.transaction.count({
        where: { buyerOrganizationId: organizationId, status: 'AWAITING_FUNDING' },
      }),
      this.prisma.transaction.count({
        where: {
          sellerOrganizationId: organizationId,
          status: { in: ['FUNDED', 'IN_PROGRESS', 'DISPUTED'] },
        },
      }),
    ]);
    const byCurrency = new Map(wallets.map((w) => [w.currencyCode, w]));
    const currencies = [];
    for (const w of balances.wallets) {
      const wallet = byCurrency.get(w.currencyCode);
      const [recent, selfDeposit] = await Promise.all([
        wallet
          ? this.entries(auth, organizationId, w.currencyCode, 1, 5)
          : Promise.resolve({ items: [] as Awaited<ReturnType<WalletsService['entries']>>['items'] }),
        this.selfDepositUsage(organizationId, w.currencyCode, wallet?.ledgerAccountId ?? null),
      ]);
      currencies.push({
        currencyCode: w.currencyCode,
        walletId: w.walletId,
        balance: w.balance,
        entryCount: w.entryCount,
        recentOperations: recent.items,
        statementPath: this.statementPath(organizationId, w.currencyCode),
        selfDeposit: {
          limit: selfDeposit.limit,
          usedToday: selfDeposit.usedToday,
          remaining: selfDeposit.remaining,
        },
      });
    }
    return {
      organizationId,
      simulated: true,
      disclaimer: SANDBOX_DISCLAIMER_FR,
      currencies,
      pending: { awaitingFundingAsBuyer, escrowsHoldingAsSeller },
      links: {
        beneficiaries: `/v1/beneficiaries?organizationId=${organizationId}`,
        statements: Object.fromEntries(
          balances.wallets.map((w) => [w.currencyCode, this.statementPath(organizationId, w.currencyCode)]),
        ),
      },
    };
  }

  /**
   * Indicative conversion estimate — pure computation, nothing is persisted.
   * Mirrors the executable quote (`FxQuotesService`): the fee is charged in the source currency
   * ON TOP of the converted amount, never deducted from it:
   *   destination / estimatedReceived = full source amount converted at the (spread-inclusive) rate
   *   totalDebit                      = source amount + fee (what the wallet is debited)
   */
  async estimate(input: ConversionEstimateInput) {
    const source = input.sourceCurrency;
    const destination = input.destinationCurrency;
    const amountMinor = parseDecimalToMinor(input.amount, source);
    if (amountMinor <= 0n) throw DomainError.validation('Amount must be greater than zero');
    let rate;
    try {
      rate = await this.fx.getRate(source, destination);
    } catch (err) {
      throw DomainError.validation(err instanceof Error ? err.message : 'Unsupported currency pair');
    }
    const fee = quoteTransferFee(amountMinor, source);
    const grossMinor = convertMinor(amountMinor, rate, source, destination);
    const totalDebitMinor = amountMinor + fee.feeMinor;
    const srcExp = getCurrency(source).exponent;
    const dstExp = getCurrency(destination).exponent;
    // Rate on major units with 6 decimals, integer arithmetic only.
    const scaled = (rate.numerator * 1_000_000n + rate.denominator / 2n) / rate.denominator;
    const display = `1 ${source} = ${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, '0')} ${destination}`;
    return {
      source: moneyDto(amountMinor, source),
      destination: moneyDto(grossMinor, destination),
      rate: { numerator: rate.numerator.toString(), denominator: rate.denominator.toString(), display },
      spreadBps: rate.spreadBps,
      fee: {
        ...moneyDto(fee.feeMinor, source)!,
        feeBps: fee.feeBps,
        fixedFee: moneyDto(fee.fixedFeeMinor, source),
      },
      /** Amount actually converted (the full source amount — the fee is charged on top). */
      netSource: moneyDto(amountMinor, source),
      estimatedReceived: moneyDto(grossMinor, destination),
      totalDebit: moneyDto(totalDebitMinor, source),
      exponents: { source: srcExp, destination: dstExp },
      simulated: true as const,
      provider: rate.provider,
      asOf: rate.asOf,
      disclaimer: SANDBOX_DISCLAIMER_FR,
    };
  }

  /**
   * Sandbox self-service deposit: credits fictitious units to the organisation wallet from the
   * simulated partner settlement account, within a daily cap per organisation and currency.
   */
  async selfDeposit(auth: AuthContext, input: SandboxSelfDepositInput, req: Request) {
    const { organizationId } = input;
    const currencyCode = input.currencyCode;
    const membership = membershipFor(auth, organizationId);
    if (!membership) throw DomainError.notFound('Organization');
    if (
      !orgRoleHas(membership.role, Permission.WALLET_READ) ||
      !orgRoleHas(membership.role, Permission.TRANSFER_CREATE)
    ) {
      throw DomainError.forbidden(`Your role (${membership.role}) does not allow sandbox deposits`);
    }
    const amountMinor = parseDecimalToMinor(input.amount, currencyCode);
    if (amountMinor <= 0n) throw DomainError.validation('Amount must be greater than zero');
    // Scoped by organisation AND currency: replaying a key with another currency must not return the
    // original (other-currency) posting.
    const idempotencyKey = `self-deposit:${organizationId}:${currencyCode}:${input.idempotencyKey ?? randomUUID()}`;
    const wallet = await this.ensureWallet(organizationId, currencyCode);

    const replayed = await this.ledger.findByIdempotencyKey(idempotencyKey);
    if (replayed) {
      const balance = await this.ledger.getBalance(wallet.ledgerAccountId);
      const usage = await this.selfDepositUsage(organizationId, currencyCode, wallet.ledgerAccountId);
      return {
        ledgerTransactionId: replayed.id,
        newBalance: moneyDto(balance.balanceMinor, currencyCode),
        replayed: true,
        simulated: true as const,
        dailyCap: { limit: usage.limit, usedToday: usage.usedToday, remaining: usage.remaining },
      };
    }

    const meta = requestMeta(req);
    const result = await this.prisma.$transaction(async (db) => {
      // Serialise concurrent self-deposits on the same wallet so the cap cannot be bypassed.
      await db.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      const usage = await this.selfDepositUsage(organizationId, currencyCode, wallet.ledgerAccountId, db);
      if (usage.usedMinor + amountMinor > usage.limitMinor) {
        throw new DomainError(
          'SANDBOX_LIMIT_REACHED',
          `Daily sandbox self-deposit limit reached for ${currencyCode}`,
          HttpStatus.CONFLICT,
          {
            limit: usage.limit,
            usedToday: usage.usedToday,
            remaining: usage.remaining,
            requested: moneyDto(amountMinor, currencyCode),
          },
        );
      }
      const posted = await this.ledger.post(
        {
          idempotencyKey,
          kind: 'DEPOSIT',
          description: `Sandbox self-deposit of ${minorToDecimalString(amountMinor, currencyCode)} ${currencyCode} (simulated — no real funds)`,
          reference: organizationId,
          metadata: {
            simulated: true,
            selfService: true,
            organizationId,
            currencyCode,
            amountMinor: amountMinor.toString(),
            by: auth.userId,
          },
          entries: [
            {
              accountCode: providerSettlementCode(SANDBOX_PROVIDER_CODE, currencyCode),
              direction: 'DEBIT',
              amountMinor,
              currencyCode,
            },
            { accountId: wallet.ledgerAccountId, direction: 'CREDIT', amountMinor, currencyCode },
          ],
        },
        db,
      );
      const balance = await this.ledger.getBalance(wallet.ledgerAccountId, db);
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: 'sandbox.wallet_self_deposit',
          entityType: 'Wallet',
          entityId: wallet.id,
          metadata: {
            amount: minorToDecimalString(amountMinor, currencyCode),
            currency: currencyCode,
            ledgerTransactionId: posted.id,
            idempotencyKey,
            simulated: true,
          },
          ...meta,
        },
        db,
      );
      return { posted, balance, usedMinor: usage.usedMinor + amountMinor, limitMinor: usage.limitMinor };
    });

    await this.notifications.notify({
      userId: auth.userId,
      type: 'wallet.self_deposit',
      title: 'Dépôt fictif crédité',
      body: `${minorToDecimalString(amountMinor, currencyCode)} ${currencyCode} fictifs ont été crédités sur le portefeuille ${membership.organizationName} (sandbox — aucun fonds réel).`,
      data: { organizationId, currencyCode, ledgerTransactionId: result.posted.id },
    });
    // Post-commit AML evaluation (structuring of many small deposits). The deposit is booked: an
    // evaluation failure is logged, never returned to the caller.
    try {
      await this.risk.evaluateAndRecord({
        event: 'wallet.self_deposit',
        userId: auth.userId,
        organizationId,
        amountMinor,
        currencyCode,
        operationReference: result.posted.id,
      });
    } catch (err) {
      this.logger.error(`risk evaluation after self-deposit ${result.posted.id} failed: ${String(err)}`);
    }
    const remainingMinor =
      result.limitMinor - result.usedMinor > 0n ? result.limitMinor - result.usedMinor : 0n;
    return {
      ledgerTransactionId: result.posted.id,
      newBalance: moneyDto(result.balance.balanceMinor, currencyCode),
      replayed: false,
      simulated: true as const,
      dailyCap: {
        limit: moneyDto(result.limitMinor, currencyCode),
        usedToday: moneyDto(result.usedMinor, currencyCode),
        remaining: moneyDto(remainingMinor, currencyCode),
      },
    };
  }
}
