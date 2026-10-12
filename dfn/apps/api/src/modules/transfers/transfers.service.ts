import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Prisma, PrismaTransactionClient, Transfer } from '@dfn/database';
import {
  LedgerService,
  fxClearingCode,
  platformFeesCode,
  providerSettlementCode,
} from '@dfn/financial-ledger';
import { SANDBOX_PROVIDER_CODE } from '@dfn/payment-adapters';
import {
  globalRoleHas,
  ErrorCode,
  Permission,
  TransferEventType,
  getCurrency,
  isCorridorSupported,
  minorToDecimalString,
  orgRoleHas,
  parseDecimalToMinor,
  securityPreferencesSchema,
  transferMachine,
  type AuthorizeTransferInput,
  type CreateTransferInput,
  type ListTransfersQuery,
  type ReviewTransferInput,
} from '@dfn/shared';
import type { RiskFacts } from '@dfn/compliance';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { randomToken } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { DomainEventsBus } from '../../common/events/domain-events';
import { paginate } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { moneyDto } from '../../common/serialize';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { MfaVerifierService } from '../auth/mfa-verifier.service';
import type { JobResult } from '../jobs/job-registry';
import { LEDGER } from '../ledger/ledger.provider';
import { WalletsService } from '../ledger/wallets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RiskService } from '../risk/risk.service';
import { FxQuotesService } from './fx-quotes.service';
import {
  TRANSFER_DISCLAIMER_FR,
  receiptToText,
  toTransferDto,
  toTransferReceipt,
  toTransferSummary,
  type TransferViewer,
  type TransferWithRelations,
} from './transfer.dto';

/** PROCESSING transfers older than this are auto-settled by the TRANSFER_PROCESSING job. */
export const SANDBOX_AUTO_SETTLE_AFTER_MS = 60_000;

export type PartnerOutcome = 'SETTLED' | 'FAILED';

interface PartnerOutcomeOptions {
  actorUserId: string | null;
  failureReason?: string;
  externalRef?: string;
  triggeredBy: string;
}

/** Nominal decimal limit ("2500.00") re-scaled to the currency exponent, parsed to minor units. */
export function nominalLimitToMinor(limit: string, currencyCode: string): bigint {
  const { exponent } = getCurrency(currencyCode);
  const [whole, frac = ''] = limit.trim().replace(',', '.').split('.');
  const scaledFrac = frac.slice(0, exponent).padEnd(exponent, '0');
  return parseDecimalToMinor(exponent === 0 ? whole : `${whole}.${scaledFrac}`, currencyCode);
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function metadataOf(transfer: Pick<Transfer, 'metadata'>): Record<string, unknown> {
  return transfer.metadata && typeof transfer.metadata === 'object' && !Array.isArray(transfer.metadata)
    ? (transfer.metadata as Record<string, unknown>)
    : {};
}

const TRANSFER_INCLUDE = {
  events: { orderBy: { createdAt: 'asc' as const } },
  quote: true,
  provider: true,
  organization: { select: { id: true, name: true, type: true } },
  createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
} satisfies Prisma.TransferInclude;

/**
 * Diaspora Transfer — simulated international transfers funded from the organisation wallet.
 *
 *  QUOTED ──authorize──▶ (risk) ──▶ PROCESSING ──partner──▶ SETTLED
 *                         │                      └──────▶ FAILED (source leg reversed)
 *                         └──▶ REVIEW_REQUIRED ──staff──▶ PROCESSING | CANCELLED
 *
 * Every money movement is a balanced ledger posting; the wallet is only debited once the
 * transfer is authorised, and refunded by reversal when the simulated partner fails.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly organizations: OrganizationsService,
    private readonly quotes: FxQuotesService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
    private readonly bus: DomainEventsBus,
    @Inject(ENV) private readonly env: Env,
    private readonly mfa: MfaVerifierService,
  ) {}

  // ───────────────────────────── Access ─────────────────────────────

  /** Loads a transfer the caller may see (organisation member or staff); other tenants get 404. */
  async loadFor(auth: AuthContext, id: string): Promise<TransferWithRelations> {
    const transfer = await this.prisma.transfer.findUnique({ where: { id }, include: TRANSFER_INCLUDE });
    if (!transfer) throw DomainError.notFound('Transfer');
    if (!isStaff(auth) && !membershipFor(auth, transfer.organizationId))
      throw DomainError.notFound('Transfer');
    return this.expireIfStale(transfer);
  }

  viewerFor(auth: AuthContext, transfer: Pick<Transfer, 'organizationId'>): TransferViewer {
    return { isStaff: isStaff(auth), role: membershipFor(auth, transfer.organizationId)?.role ?? null };
  }

  private async reload(id: string, db: PrismaTransactionClient | PrismaService = this.prisma) {
    return db.transfer.findUniqueOrThrow({ where: { id }, include: TRANSFER_INCLUDE });
  }

  private async providerRecord(db: PrismaTransactionClient | PrismaService = this.prisma) {
    return db.paymentProvider.findUniqueOrThrow({ where: { code: SANDBOX_PROVIDER_CODE } });
  }

  private async recordEvent(
    db: PrismaTransactionClient | PrismaService,
    transferId: string,
    type: TransferEventType,
    actorUserId: string | null,
    payload?: Record<string, unknown>,
  ) {
    return db.transferEvent.create({
      data: {
        transferId,
        type,
        actorUserId,
        payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private async generateReference(db: PrismaTransactionClient): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = `DFT-${new Date().getUTCFullYear()}-${randomToken(4)
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase()
        .padEnd(6, '7')
        .slice(0, 6)}`;
      const exists = await db.transfer.findUnique({ where: { reference: candidate }, select: { id: true } });
      if (!exists) return candidate;
    }
    throw DomainError.conflict('Could not allocate a transfer reference');
  }

  // ───────────────────────────── Expiry ─────────────────────────────

  /** A QUOTED transfer whose quote validity has elapsed becomes EXPIRED (lazy, on read). */
  private async expireIfStale(transfer: TransferWithRelations): Promise<TransferWithRelations> {
    if (transfer.status !== 'QUOTED') return transfer;
    const expiresAt = transfer.quote?.expiresAt ?? null;
    if (!expiresAt || expiresAt > new Date()) return transfer;
    await this.expireOne(transfer.id);
    return this.reload(transfer.id);
  }

  private async expireOne(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (db) => {
      const updated = await db.transfer.updateMany({
        where: { id, status: 'QUOTED' },
        data: { status: 'EXPIRED' },
      });
      if (!updated.count) return false;
      transferMachine.assertTransition('QUOTED', 'EXPIRED');
      await this.recordEvent(db, id, TransferEventType.EXPIRED, null, { reason: 'Quote validity elapsed' });
      await this.audit.log(
        {
          action: 'transfer.expired',
          entityType: 'Transfer',
          entityId: id,
          metadata: { reason: 'quote_expired' },
        },
        db,
      );
      return true;
    });
  }

  /** Expires every QUOTED transfer whose quote validity has elapsed (optionally scoped to organisations). */
  async expireStaleTransfers(organizationIds?: string[]): Promise<number> {
    const stale = await this.prisma.transfer.findMany({
      where: {
        status: 'QUOTED',
        quote: { expiresAt: { lt: new Date() } },
        ...(organizationIds ? { organizationId: { in: organizationIds } } : {}),
      },
      select: { id: true },
    });
    let expired = 0;
    for (const t of stale) if (await this.expireOne(t.id)) expired++;
    return expired;
  }

  // ───────────────────────────── Risk facts ─────────────────────────────

  private async riskFacts(params: {
    userId: string;
    organizationId: string;
    amountMinor: bigint;
    currencyCode: string;
    originCountry: string;
    destinationCountry: string;
    beneficiaryCreatedAt: Date | null;
  }): Promise<Omit<RiskFacts, 'event'>> {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const activeStatuses = { notIn: ['CANCELLED', 'EXPIRED'] as Transfer['status'][] };
    const [user, transfersLast24h, amountLast24h, verification, wallet] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: params.userId },
        select: { country: true, createdAt: true },
      }),
      this.prisma.transfer.count({
        where: {
          organizationId: params.organizationId,
          createdAt: { gte: since24h },
          status: activeStatuses,
        },
      }),
      this.prisma.transfer.aggregate({
        where: {
          organizationId: params.organizationId,
          sourceCurrency: params.currencyCode,
          createdAt: { gte: since24h },
          status: activeStatuses,
        },
        _sum: { sourceAmountMinor: true },
      }),
      this.prisma.identityVerification.findFirst({
        where: { userId: params.userId, status: 'SIMULATED_PASS' },
        select: { id: true },
      }),
      this.prisma.wallet.findUnique({
        where: {
          organizationId_currencyCode: {
            organizationId: params.organizationId,
            currencyCode: params.currencyCode,
          },
        },
      }),
    ]);
    const walletBalanceMinor = wallet
      ? (await this.ledger.getBalance(wallet.ledgerAccountId)).balanceMinor
      : 0n;
    return {
      userId: params.userId,
      organizationId: params.organizationId,
      amountMinor: params.amountMinor,
      currencyCode: params.currencyCode,
      transfersLast24h,
      transfersAmountLast24hMinor: amountLast24h._sum.sourceAmountMinor ?? 0n,
      beneficiaryAgeHours: params.beneficiaryCreatedAt
        ? Math.floor((Date.now() - params.beneficiaryCreatedAt.getTime()) / 3_600_000)
        : undefined,
      walletBalanceMinor,
      identityVerified: Boolean(verification),
      userCountry: user?.country ?? undefined,
      originCountry: params.originCountry,
      destinationCountry: params.destinationCountry,
      corridorSupported: isCorridorSupported(params.originCountry, params.destinationCountry),
      accountAgeDays: user ? Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000) : undefined,
    };
  }

  // ───────────────────────────── Notifications ─────────────────────────────

  /** Creator + organisation owners/admins, honouring the `transferAlerts` security preference. */
  private async recipientsFor(
    transfer: Pick<Transfer, 'organizationId' | 'createdByUserId'>,
    extra: string[] = [],
  ) {
    const managers = await this.prisma.organizationMember.findMany({
      where: { organizationId: transfer.organizationId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true },
    });
    const ids = [...new Set([transfer.createdByUserId, ...managers.map((m) => m.userId), ...extra])];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, status: 'ACTIVE', deletedAt: null },
      select: { id: true, securityPreferences: true },
    });
    return users
      .filter((u) => {
        const parsed = securityPreferencesSchema.safeParse(u.securityPreferences ?? {});
        return parsed.success ? parsed.data.transferAlerts !== false : true;
      })
      .map((u) => u.id);
  }

  private async notifyTransfer(
    transfer: TransferWithRelations,
    type: string,
    title: string,
    body: string,
    extraRecipients: string[] = [],
  ) {
    const recipients = await this.recipientsFor(transfer, extraRecipients);
    await this.notifications.notifyMany(recipients, {
      type,
      title,
      body: `${body} ${TRANSFER_DISCLAIMER_FR}.`,
      data: { transferId: transfer.id, reference: transfer.reference, status: transfer.status },
    });
  }

  private async notifyStaff(transfer: TransferWithRelations, title: string, body: string) {
    const staff = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null, globalRole: { in: ['ADMIN', 'COMPLIANCE'] } },
      select: { id: true },
    });
    await this.notifications.notifyMany(
      staff.map((u) => u.id),
      {
        type: 'transfer.review_required',
        title,
        body: `${body} ${TRANSFER_DISCLAIMER_FR}.`,
        data: { transferId: transfer.id, reference: transfer.reference, riskScore: transfer.riskScore },
      },
    );
  }

  private describe(transfer: Pick<Transfer, 'sourceAmountMinor' | 'sourceCurrency' | 'beneficiary'>) {
    const beneficiary = (transfer.beneficiary ?? {}) as Record<string, unknown>;
    const name = typeof beneficiary.name === 'string' ? beneficiary.name : 'bénéficiaire';
    return `${minorToDecimalString(transfer.sourceAmountMinor, transfer.sourceCurrency)} ${transfer.sourceCurrency} vers « ${name} »`;
  }

  // ───────────────────────────── Create ─────────────────────────────

  async create(auth: AuthContext, input: CreateTransferInput, req: Request) {
    const quoteRow = await this.prisma.fXQuote.findUnique({ where: { id: input.quoteId } });
    if (!quoteRow) throw DomainError.notFound('Quote');
    // Cross-organisation quotes are invisible (404); members without the permission get 403.
    this.organizations.resolveActingOrganization(auth, quoteRow.organizationId, Permission.TRANSFER_CREATE);
    const quote = await this.quotes.expireIfStale(quoteRow);
    if (quote.status === 'EXPIRED') {
      throw new DomainError(
        'QUOTE_EXPIRED',
        'The quote has expired — request a new one',
        HttpStatus.CONFLICT,
        {
          quoteId: quote.id,
          expiresAt: quote.expiresAt,
        },
      );
    }
    if (quote.status !== 'QUOTED') {
      throw new DomainError('QUOTE_USED', 'The quote has already been used', HttpStatus.CONFLICT, {
        quoteId: quote.id,
      });
    }
    const beneficiary = await this.prisma.beneficiary.findUnique({ where: { id: input.beneficiaryId } });
    if (!beneficiary || beneficiary.organizationId !== quote.organizationId) {
      throw DomainError.notFound('Beneficiary');
    }
    if (beneficiary.status !== 'ACTIVE') {
      throw new DomainError('BENEFICIARY_INACTIVE', 'Beneficiary has been removed', HttpStatus.BAD_REQUEST, {
        beneficiaryId: beneficiary.id,
      });
    }
    if (
      beneficiary.currencyCode !== quote.destinationCurrency ||
      (quote.destinationCountry && beneficiary.country !== quote.destinationCountry)
    ) {
      throw new DomainError(
        'BENEFICIARY_MISMATCH',
        'Beneficiary country/currency does not match the quote destination',
        HttpStatus.BAD_REQUEST,
        {
          beneficiary: { country: beneficiary.country, currencyCode: beneficiary.currencyCode },
          quote: {
            destinationCountry: quote.destinationCountry,
            destinationCurrency: quote.destinationCurrency,
          },
        },
      );
    }
    if (!quote.originCountry) throw DomainError.validation('Quote has no origin country');
    const originCountry = quote.originCountry;
    const destinationCountry = quote.destinationCountry ?? beneficiary.country;
    const meta = requestMeta(req);
    const provider = await this.providerRecord();

    const created = await this.prisma.$transaction(async (db) => {
      // Serialise concurrent creations on the same quote: exactly one transfer per quote.
      const [locked] = await db.$queryRaw<Array<{ id: string; status: string; expiresAt: Date }>>`
        SELECT id, status, "expiresAt" FROM "FXQuote" WHERE id = ${quote.id}::uuid FOR UPDATE`;
      if (!locked || locked.status !== 'QUOTED') {
        throw new DomainError('QUOTE_USED', 'The quote has already been used', HttpStatus.CONFLICT, {
          quoteId: quote.id,
        });
      }
      if (locked.expiresAt <= new Date()) {
        throw new DomainError('QUOTE_EXPIRED', 'The quote has expired', HttpStatus.CONFLICT, {
          quoteId: quote.id,
        });
      }
      await db.fXQuote.update({ where: { id: quote.id }, data: { status: 'USED' } });
      const reference = await this.generateReference(db);
      const now = new Date();
      transferMachine.assertTransition('CREATED', 'QUOTED');
      const transfer = await db.transfer.create({
        data: {
          reference,
          organizationId: quote.organizationId,
          createdByUserId: auth.userId,
          providerId: provider.id,
          quoteId: quote.id,
          beneficiaryId: beneficiary.id,
          originCountry,
          destinationCountry,
          sourceCurrency: quote.sourceCurrency,
          destinationCurrency: quote.destinationCurrency,
          sourceAmountMinor: quote.sourceAmountMinor,
          feeMinor: quote.feeMinor,
          destinationAmountMinor: quote.destinationAmountMinor,
          rateNumerator: quote.rateNumerator,
          rateDenominator: quote.rateDenominator,
          status: 'QUOTED',
          purpose: input.purpose,
          beneficiary: {
            id: beneficiary.id,
            name: beneficiary.name,
            country: beneficiary.country,
            currencyCode: beneficiary.currencyCode,
            method: beneficiary.method,
            accountIdentifierMasked: beneficiary.accountIdentifierMasked,
            institutionName: beneficiary.institutionName,
          },
          quotedAt: now,
          metadata: {
            simulated: true,
            feeBps: quote.feeBps,
            fixedFeeMinor: quote.fixedFeeMinor.toString(),
            quoteExpiresAt: quote.expiresAt.toISOString(),
            provider: quote.provider,
            ...(input.reference ? { clientReference: input.reference } : {}),
          },
        },
      });
      await this.recordEvent(db, transfer.id, TransferEventType.CREATED, auth.userId, {
        quoteId: quote.id,
        beneficiaryId: beneficiary.id,
        purpose: input.purpose,
      });
      await this.recordEvent(db, transfer.id, TransferEventType.QUOTED, auth.userId, {
        source: minorToDecimalString(quote.sourceAmountMinor, quote.sourceCurrency),
        sourceCurrency: quote.sourceCurrency,
        fee: minorToDecimalString(quote.feeMinor, quote.sourceCurrency),
        destination: minorToDecimalString(quote.destinationAmountMinor, quote.destinationCurrency),
        destinationCurrency: quote.destinationCurrency,
        quoteExpiresAt: quote.expiresAt.toISOString(),
        simulated: true,
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: quote.organizationId,
          action: 'transfer.created',
          entityType: 'Transfer',
          entityId: transfer.id,
          metadata: {
            reference,
            quoteId: quote.id,
            beneficiaryId: beneficiary.id,
            accountIdentifierMasked: beneficiary.accountIdentifierMasked,
            source: minorToDecimalString(quote.sourceAmountMinor, quote.sourceCurrency),
            sourceCurrency: quote.sourceCurrency,
            destinationCurrency: quote.destinationCurrency,
            simulated: true,
          },
          ...meta,
        },
        db,
      );
      return transfer;
    });

    const facts = await this.riskFacts({
      userId: auth.userId,
      organizationId: created.organizationId,
      amountMinor: created.sourceAmountMinor,
      currencyCode: created.sourceCurrency,
      originCountry,
      destinationCountry,
      beneficiaryCreatedAt: beneficiary.createdAt,
    });
    const evaluation = await this.risk.evaluateAndRecord({ ...facts, event: 'transfer.created' });
    if (evaluation.totalScore > 0) {
      await this.prisma.transfer.update({
        where: { id: created.id },
        data: { riskScore: evaluation.totalScore },
      });
    }
    const full = await this.reload(created.id);
    await this.notifyTransfer(
      full,
      'transfer.created',
      `Transfert créé (simulé) — ${full.reference}`,
      `Le transfert de ${this.describe(full)} est prêt à être autorisé. Le devis est valable jusqu'au ${quote.expiresAt.toISOString()}.`,
    );
    return toTransferDto(full, this.viewerFor(auth, full));
  }

  // ───────────────────────────── Authorise ─────────────────────────────

  /**
   * Transfer step-up. The proof — TOTP code (anti-replay), recovery code or passkey assertion for
   * a STEP_UP challenge of this session — is checked by MfaVerifierService (ADR-0009).
   */
  private async assertMfa(auth: AuthContext, input: AuthorizeTransferInput, req?: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { mfaEnabled: true, securityPreferences: true },
    });
    const parsed = securityPreferencesSchema.safeParse(user.securityPreferences ?? {});
    const prefs = parsed.success
      ? parsed.data
      : { requireMfaForTransfers: true, transferAlerts: true, dailyTransferLimit: null };
    const mfaRequired = user.mfaEnabled && prefs.requireMfaForTransfers !== false;
    if (mfaRequired) {
      await this.mfa.assertFreshProof(
        auth,
        input,
        'transfer.authorize',
        {
          code: ErrorCode.MFA_REQUIRED,
          message: 'A valid two-factor code is required to authorise this transfer',
          status: HttpStatus.UNAUTHORIZED,
        },
        req,
      );
    }
    return { mfaVerified: mfaRequired, dailyTransferLimit: prefs.dailyTransferLimit ?? null };
  }

  /**
   * Sum (source amount) of the transfers this user authorised today (UTC), in the given currency.
   * FAILED transfers are excluded: the partner rejected them and the wallet was refunded in full.
   */
  private async authorizedTodayMinor(
    userId: string,
    currencyCode: string,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<bigint> {
    const rows = await db.transfer.findMany({
      where: {
        sourceCurrency: currencyCode,
        authorizedAt: { gte: startOfUtcDay() },
        status: { in: ['AUTHORIZED', 'PROCESSING', 'SETTLED'] },
        metadata: { path: ['authorizedByUserId'], equals: userId },
      },
      select: { sourceAmountMinor: true },
    });
    return rows.reduce((acc, r) => acc + r.sourceAmountMinor, 0n);
  }

  async authorize(auth: AuthContext, id: string, input: AuthorizeTransferInput, req: Request) {
    const transfer = await this.loadFor(auth, id);
    this.organizations.resolveActingOrganization(
      auth,
      transfer.organizationId,
      Permission.TRANSFER_AUTHORIZE,
    );
    if (transfer.status === 'EXPIRED') {
      throw new DomainError(
        'QUOTE_EXPIRED',
        'The quote behind this transfer has expired',
        HttpStatus.CONFLICT,
        {
          transferId: transfer.id,
        },
      );
    }
    if (transfer.status === 'REVIEW_REQUIRED') {
      throw DomainError.invalidTransition('Transfer awaits compliance review', {
        entity: 'Transfer',
        from: transfer.status,
        to: 'AUTHORIZED',
      });
    }
    transferMachine.assertTransition(transfer.status, 'AUTHORIZED');
    const { mfaVerified, dailyTransferLimit } = await this.assertMfa(auth, input, req);

    if (dailyTransferLimit) {
      const limitMinor = nominalLimitToMinor(dailyTransferLimit, transfer.sourceCurrency);
      const usedMinor = await this.authorizedTodayMinor(auth.userId, transfer.sourceCurrency);
      if (usedMinor + transfer.sourceAmountMinor > limitMinor) {
        throw new DomainError(
          'DAILY_LIMIT_EXCEEDED',
          `Your daily transfer limit for ${transfer.sourceCurrency} would be exceeded`,
          HttpStatus.CONFLICT,
          {
            limit: moneyDto(limitMinor, transfer.sourceCurrency),
            usedToday: moneyDto(usedMinor, transfer.sourceCurrency),
            requested: moneyDto(transfer.sourceAmountMinor, transfer.sourceCurrency),
          },
        );
      }
    }

    const beneficiary = transfer.beneficiaryId
      ? await this.prisma.beneficiary.findUnique({ where: { id: transfer.beneficiaryId } })
      : null;
    const facts = await this.riskFacts({
      userId: auth.userId,
      organizationId: transfer.organizationId,
      amountMinor: transfer.sourceAmountMinor,
      currencyCode: transfer.sourceCurrency,
      originCountry: transfer.originCountry,
      destinationCountry: transfer.destinationCountry,
      beneficiaryCreatedAt: beneficiary?.createdAt ?? null,
    });
    const evaluation = await this.risk.evaluateAndRecord({
      ...facts,
      event: 'transfer.authorized',
      operationReference: transfer.reference,
    });
    const meta = requestMeta(req);

    if (evaluation.recommendation === 'MANUAL_REVIEW') {
      const reviewReason = evaluation.signals
        .map((s) => `${s.ruleCode}: ${s.explanation.summary}`)
        .join(' | ');
      await this.prisma.$transaction(async (db) => {
        const [locked] = await db.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM "Transfer" WHERE id = ${transfer.id}::uuid FOR UPDATE`;
        if (!locked || locked.status !== 'QUOTED') {
          throw DomainError.invalidTransition('Transfer is no longer awaiting authorisation', {
            entity: 'Transfer',
            from: locked?.status ?? 'UNKNOWN',
            to: 'REVIEW_REQUIRED',
          });
        }
        transferMachine.assertTransition('QUOTED', 'REVIEW_REQUIRED');
        await db.transfer.update({
          where: { id: transfer.id },
          data: {
            status: 'REVIEW_REQUIRED',
            reviewReason,
            riskScore: evaluation.totalScore,
            metadata: { ...metadataOf(transfer), authorizationRequestedByUserId: auth.userId, mfaVerified },
          },
        });
        await this.recordEvent(db, transfer.id, TransferEventType.REVIEW_REQUIRED, auth.userId, {
          riskScore: evaluation.totalScore,
          signals: evaluation.signals.map((s) => s.ruleCode),
          reason: reviewReason,
        });
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: transfer.organizationId,
            action: 'transfer.review_required',
            entityType: 'Transfer',
            entityId: transfer.id,
            metadata: {
              reference: transfer.reference,
              riskScore: evaluation.totalScore,
              reviewReason,
              mfaVerified,
            },
            ...meta,
          },
          db,
        );
      });
      const full = await this.reload(transfer.id);
      await this.notifyTransfer(
        full,
        'transfer.review_required',
        `Transfert en revue de conformité — ${full.reference}`,
        `Le transfert de ${this.describe(full)} a été mis en attente d'une revue par l'équipe conformité. Aucun fonds fictif n'a été débité.`,
      );
      await this.notifyStaff(
        full,
        `Revue requise — transfert ${full.reference}`,
        `Score de risque ${evaluation.totalScore} (${evaluation.signals.map((s) => s.ruleCode).join(', ')}). ${this.describe(full)}.`,
      );
      return toTransferDto(full, this.viewerFor(auth, full));
    }

    const posted = await this.postSourceLeg(transfer, auth.userId, {
      via: 'AUTHORIZE',
      riskScore: evaluation.totalScore,
      mfaVerified,
      dailyLimitMinor: dailyTransferLimit
        ? nominalLimitToMinor(dailyTransferLimit, transfer.sourceCurrency)
        : null,
      ...meta,
    });
    await this.notifyTransfer(
      posted,
      'transfer.processing',
      `Transfert en traitement (simulé) — ${posted.reference}`,
      `${minorToDecimalString(posted.sourceAmountMinor + posted.feeMinor, posted.sourceCurrency)} ${posted.sourceCurrency} fictifs ont été débités du portefeuille et le partenaire simulé traite le transfert de ${this.describe(posted)}.`,
    );
    return toTransferDto(posted, this.viewerFor(auth, posted));
  }

  /**
   * Source leg: wallet → FX clearing (+ platform fee), then AUTHORIZED → PROCESSING with the
   * partner's (simulated) acceptance. Atomic: either everything commits or nothing does.
   */
  private async postSourceLeg(
    transfer: TransferWithRelations,
    actorUserId: string,
    opts: {
      via: 'AUTHORIZE' | 'REVIEW_APPROVE';
      riskScore: number | null;
      mfaVerified?: boolean;
      /** User daily cap (minor units of the source currency), re-checked under the row lock. */
      dailyLimitMinor?: bigint | null;
      reviewNote?: string;
      ip?: string;
      userAgent?: string;
    },
  ): Promise<TransferWithRelations> {
    const expected = opts.via === 'AUTHORIZE' ? 'QUOTED' : 'REVIEW_REQUIRED';
    const src = transfer.sourceCurrency;
    const total = transfer.sourceAmountMinor + transfer.feeMinor;
    const provider = await this.providerRecord();
    await this.prisma.$transaction(async (db) => {
      const [locked] = await db.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM "Transfer" WHERE id = ${transfer.id}::uuid FOR UPDATE`;
      if (!locked || locked.status !== expected) {
        throw DomainError.invalidTransition(
          `Transfer is ${locked?.status ?? 'missing'}, expected ${expected}`,
          {
            entity: 'Transfer',
            from: locked?.status ?? 'UNKNOWN',
            to: 'AUTHORIZED',
          },
        );
      }
      transferMachine.assertTransition(locked.status as Transfer['status'], 'AUTHORIZED');
      transferMachine.assertTransition('AUTHORIZED', 'PROCESSING');

      // Quote validity is re-checked here, under the lock, so a quote expiring between the
      // pre-checks (MFA, risk evaluation) and the posting is never executed. A transfer approved
      // after a compliance review keeps the rate it was quoted at: the review freezes the quote
      // (the customer accepted that rate when authorising; the sandbox rate is fixed anyway).
      if (opts.via === 'AUTHORIZE' && transfer.quote?.expiresAt && transfer.quote.expiresAt <= new Date()) {
        throw new DomainError(
          'QUOTE_EXPIRED',
          'The quote behind this transfer has expired',
          HttpStatus.CONFLICT,
          {
            transferId: transfer.id,
          },
        );
      }
      if (opts.via === 'AUTHORIZE' && opts.dailyLimitMinor != null) {
        // Re-computed under the lock: concurrent authorisations serialise on the Transfer row of
        // each transfer, so the sum below includes every authorisation that already committed.
        const usedMinor = await this.authorizedTodayMinor(actorUserId, src, db);
        if (usedMinor + transfer.sourceAmountMinor > opts.dailyLimitMinor) {
          throw new DomainError(
            'DAILY_LIMIT_EXCEEDED',
            `Your daily transfer limit for ${src} would be exceeded`,
            HttpStatus.CONFLICT,
            {
              limit: moneyDto(opts.dailyLimitMinor, src),
              usedToday: moneyDto(usedMinor, src),
              requested: moneyDto(transfer.sourceAmountMinor, src),
            },
          );
        }
      }

      const wallet = await this.wallets.ensureWallet(transfer.organizationId, src, db);
      const clearing = await this.ledger.ensureAccount(
        {
          code: fxClearingCode(src),
          name: `FX clearing (${src}) — simulated`,
          type: 'EQUITY',
          normalBalance: 'CREDIT',
          currencyCode: src,
          ownerType: 'PLATFORM',
          allowNegative: true,
        },
        db,
      );
      const posted = await this.ledger.post(
        {
          idempotencyKey: `transfer-source:${transfer.id}`,
          kind: 'WITHDRAWAL',
          description: `Transfer ${transfer.reference}: ${minorToDecimalString(transfer.sourceAmountMinor, src)} ${src} to ${transfer.destinationCountry} (simulated — no real funds)`,
          reference: transfer.id,
          metadata: {
            simulated: true,
            transferId: transfer.id,
            reference: transfer.reference,
            organizationId: transfer.organizationId,
            currencyCode: src,
            amountMinor: transfer.sourceAmountMinor.toString(),
            feeMinor: transfer.feeMinor.toString(),
            by: actorUserId,
          },
          entries: [
            { accountId: wallet.ledgerAccountId, direction: 'DEBIT', amountMinor: total, currencyCode: src },
            {
              accountId: clearing.id,
              direction: 'CREDIT',
              amountMinor: transfer.sourceAmountMinor,
              currencyCode: src,
            },
            ...(transfer.feeMinor > 0n
              ? [
                  {
                    accountCode: platformFeesCode(src),
                    direction: 'CREDIT' as const,
                    amountMinor: transfer.feeMinor,
                    currencyCode: src,
                  },
                ]
              : []),
          ],
        },
        db,
      );
      const now = new Date();
      const externalRef = `sbx_xfer_${transfer.reference.slice(-6).toLowerCase()}_${randomBytes(3).toString('hex')}`;
      await db.transfer.update({
        where: { id: transfer.id },
        data: {
          status: 'PROCESSING',
          authorizedAt: now,
          processingAt: now,
          providerId: provider.id,
          sourceLedgerTransactionId: posted.id,
          riskScore: opts.riskScore ?? transfer.riskScore,
          ...(opts.via === 'REVIEW_APPROVE' ? { reviewedByUserId: actorUserId, reviewedAt: now } : {}),
          metadata: {
            ...metadataOf(transfer),
            authorizedByUserId: actorUserId,
            authorizedVia: opts.via,
            ...(opts.mfaVerified !== undefined ? { mfaVerified: opts.mfaVerified } : {}),
            ...(opts.reviewNote ? { reviewNote: opts.reviewNote } : {}),
          },
        },
      });
      if (opts.via === 'REVIEW_APPROVE') {
        await this.recordEvent(db, transfer.id, TransferEventType.REVIEW_APPROVED, actorUserId, {
          note: opts.reviewNote,
        });
      }
      await this.recordEvent(db, transfer.id, TransferEventType.AUTHORIZED, actorUserId, {
        ledgerTransactionId: posted.id,
        debited: minorToDecimalString(total, src),
        currency: src,
        via: opts.via,
        mfaVerified: opts.mfaVerified ?? false,
        simulated: true,
      });
      await this.recordEvent(db, transfer.id, TransferEventType.PROCESSING, actorUserId, {
        provider: provider.code,
        externalRef,
        simulated: true,
      });
      await db.providerEvent.create({
        data: {
          providerId: provider.id,
          type: 'transfer.accepted',
          externalRef,
          idempotencyKey: `${provider.code}:${transfer.reference}:ACCEPTED`,
          payload: {
            transferReference: transfer.reference,
            amount: transfer.sourceAmountMinor.toString(),
            currency: src,
            destinationAmount: transfer.destinationAmountMinor.toString(),
            destinationCurrency: transfer.destinationCurrency,
            simulated: true,
          },
          status: 'PROCESSED',
          processedAt: now,
        },
      });
      await this.audit.log(
        {
          actorUserId,
          organizationId: transfer.organizationId,
          action: opts.via === 'AUTHORIZE' ? 'transfer.authorized' : 'transfer.review_approved',
          entityType: 'Transfer',
          entityId: transfer.id,
          metadata: {
            reference: transfer.reference,
            ledgerTransactionId: posted.id,
            debited: minorToDecimalString(total, src),
            currency: src,
            riskScore: opts.riskScore,
            mfaVerified: opts.mfaVerified ?? false,
            reviewNote: opts.reviewNote,
            simulated: true,
          },
          ip: opts.ip,
          userAgent: opts.userAgent,
        },
        db,
      );
    });
    this.logger.log(`transfer ${transfer.reference} → PROCESSING (${opts.via})`);
    return this.reload(transfer.id);
  }

  // ───────────────────────────── Partner outcomes ─────────────────────────────

  /**
   * Entry point of the simulated partner (sandbox webhook, the TRANSFER_PROCESSING job).
   * Idempotent on `<provider>:<reference>:<outcome>`: replaying an outcome changes nothing.
   */
  async handlePartnerOutcome(transferId: string, outcome: PartnerOutcome, opts: PartnerOutcomeOptions) {
    const transfer = await this.prisma.transfer.findUnique({ where: { id: transferId } });
    if (!transfer) throw DomainError.notFound('Transfer');
    const provider = await this.providerRecord();
    const idempotencyKey = `${provider.code}:${transfer.reference}:${outcome}`;
    const existing = await this.prisma.providerEvent.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return {
        providerEventId: existing.id,
        replayed: true,
        status: existing.status,
        outcome,
        transfer: await this.reload(transfer.id),
      };
    }
    const externalRef = opts.externalRef ?? `sbx_${outcome.toLowerCase()}_${randomBytes(6).toString('hex')}`;
    const failureReason =
      opts.failureReason?.trim() || 'Simulated partner rejection (sandbox) — fictitious funds returned';

    const result = await this.prisma.$transaction(async (db) => {
      const payload = {
        transferReference: transfer.reference,
        outcome,
        failureReason: outcome === 'FAILED' ? failureReason : undefined,
        triggeredBy: opts.triggeredBy,
        simulated: true,
      };
      const [locked] = await db.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM "Transfer" WHERE id = ${transfer.id}::uuid FOR UPDATE`;
      if (!locked || locked.status !== 'PROCESSING') {
        // A premature or late outcome is journaled under a distinct key so that it never consumes
        // the canonical `<provider>:<reference>:<outcome>` key: the real outcome must still be
        // applicable once the transfer reaches PROCESSING (otherwise funds would stay in FX clearing).
        const ignored = await db.providerEvent.create({
          data: {
            providerId: provider.id,
            type: outcome === 'SETTLED' ? 'transfer.settled' : 'transfer.failed',
            externalRef,
            idempotencyKey: `${idempotencyKey}:ignored:${randomBytes(6).toString('hex')}`,
            payload,
            status: 'IGNORED',
            error: `Transfer is ${locked?.status ?? 'missing'}`,
            processedAt: new Date(),
          },
        });
        return { providerEventId: ignored.id, status: 'IGNORED' as const, ignored: true };
      }
      const providerEvent = await db.providerEvent.create({
        data: {
          providerId: provider.id,
          type: outcome === 'SETTLED' ? 'transfer.settled' : 'transfer.failed',
          externalRef,
          idempotencyKey,
          payload,
        },
      });
      const current = await db.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
      const now = new Date();
      if (outcome === 'SETTLED') {
        transferMachine.assertTransition('PROCESSING', 'SETTLED');
        const dst = current.destinationCurrency;
        const clearing = await this.ledger.ensureAccount(
          {
            code: fxClearingCode(dst),
            name: `FX clearing (${dst}) — simulated`,
            type: 'EQUITY',
            normalBalance: 'CREDIT',
            currencyCode: dst,
            ownerType: 'PLATFORM',
            allowNegative: true,
          },
          db,
        );
        const posted = await this.ledger.post(
          {
            idempotencyKey: `transfer-dest:${current.id}`,
            kind: 'WITHDRAWAL',
            description: `Payout of ${current.reference}: ${minorToDecimalString(current.destinationAmountMinor, dst)} ${dst} by ${provider.code} (simulated — no real funds)`,
            reference: current.id,
            metadata: {
              simulated: true,
              transferId: current.id,
              reference: current.reference,
              providerEventId: providerEvent.id,
              externalRef,
            },
            entries: [
              {
                accountId: clearing.id,
                direction: 'DEBIT',
                amountMinor: current.destinationAmountMinor,
                currencyCode: dst,
              },
              {
                accountCode: providerSettlementCode(provider.code, dst),
                direction: 'CREDIT',
                amountMinor: current.destinationAmountMinor,
                currencyCode: dst,
              },
            ],
          },
          db,
        );
        await db.transfer.update({
          where: { id: current.id },
          data: { status: 'SETTLED', settledAt: now, externalRef, destinationLedgerTransactionId: posted.id },
        });
        await this.recordEvent(db, current.id, TransferEventType.SETTLED, opts.actorUserId, {
          ledgerTransactionId: posted.id,
          destination: minorToDecimalString(current.destinationAmountMinor, dst),
          destinationCurrency: dst,
          externalRef,
          triggeredBy: opts.triggeredBy,
          simulated: true,
        });
        await this.audit.log(
          {
            actorUserId: opts.actorUserId,
            organizationId: current.organizationId,
            action: 'transfer.settled',
            entityType: 'Transfer',
            entityId: current.id,
            metadata: {
              reference: current.reference,
              ledgerTransactionId: posted.id,
              externalRef,
              triggeredBy: opts.triggeredBy,
              simulated: true,
            },
          },
          db,
        );
      } else {
        transferMachine.assertTransition('PROCESSING', 'FAILED');
        if (!current.sourceLedgerTransactionId) {
          throw DomainError.conflict('Transfer has no source posting to reverse', { transferId: current.id });
        }
        const reversal = await this.ledger.reverse(
          current.sourceLedgerTransactionId,
          `transfer-reversal:${current.id}`,
          `Transfer ${current.reference} failed: ${failureReason}`,
          db,
        );
        await db.transfer.update({
          where: { id: current.id },
          data: {
            status: 'FAILED',
            failedAt: now,
            failureReason,
            externalRef,
            reversalLedgerTransactionId: reversal.id,
          },
        });
        await this.recordEvent(db, current.id, TransferEventType.FAILED, opts.actorUserId, {
          failureReason,
          externalRef,
          triggeredBy: opts.triggeredBy,
          simulated: true,
        });
        await this.recordEvent(db, current.id, TransferEventType.REVERSED, opts.actorUserId, {
          ledgerTransactionId: reversal.id,
          reverses: current.sourceLedgerTransactionId,
          refunded: minorToDecimalString(
            current.sourceAmountMinor + current.feeMinor,
            current.sourceCurrency,
          ),
          currency: current.sourceCurrency,
          simulated: true,
        });
        await this.audit.log(
          {
            actorUserId: opts.actorUserId,
            organizationId: current.organizationId,
            action: 'transfer.failed',
            entityType: 'Transfer',
            entityId: current.id,
            metadata: {
              reference: current.reference,
              failureReason,
              reversalLedgerTransactionId: reversal.id,
              externalRef,
              triggeredBy: opts.triggeredBy,
              simulated: true,
            },
          },
          db,
        );
      }
      await db.providerEvent.update({
        where: { id: providerEvent.id },
        data: { status: 'PROCESSED', processedAt: now },
      });
      return { providerEventId: providerEvent.id, status: 'PROCESSED' as const, ignored: false };
    });

    const full = await this.reload(transfer.id);
    if (!result.ignored) {
      if (outcome === 'SETTLED') {
        await this.notifyTransfer(
          full,
          'transfer.settled',
          `Transfert réglé (simulé) — ${full.reference}`,
          `Le partenaire simulé a confirmé le versement de ${minorToDecimalString(full.destinationAmountMinor, full.destinationCurrency)} ${full.destinationCurrency} fictifs au bénéficiaire (${this.describe(full)}).`,
        );
      } else {
        await this.notifyTransfer(
          full,
          'transfer.failed',
          `Transfert échoué — fonds fictifs recrédités — ${full.reference}`,
          `Le partenaire simulé a rejeté le transfert (${failureReason}). ${minorToDecimalString(full.sourceAmountMinor + full.feeMinor, full.sourceCurrency)} ${full.sourceCurrency} fictifs ont été recrédités sur le portefeuille.`,
        );
      }
      this.bus.emit({
        type: outcome === 'SETTLED' ? 'transfer.settled' : 'transfer.failed',
        organizationIds: [full.organizationId],
        entityType: 'Transfer',
        entityId: full.id,
        payload: {
          transferId: full.id,
          reference: full.reference,
          status: full.status,
          sourceAmount: minorToDecimalString(full.sourceAmountMinor, full.sourceCurrency),
          destinationAmount: minorToDecimalString(full.destinationAmountMinor, full.destinationCurrency),
          sourceCurrency: full.sourceCurrency,
          destinationCurrency: full.destinationCurrency,
          ...(outcome === 'FAILED' ? { failureReason } : {}),
          simulated: true,
        },
      });
      this.logger.log(`transfer ${full.reference} → ${full.status} (${opts.triggeredBy})`);
    }
    return {
      providerEventId: result.providerEventId,
      replayed: false,
      status: result.status,
      outcome,
      transfer: full,
    };
  }

  // ───────────────────────────── Cancel ─────────────────────────────

  async cancel(auth: AuthContext, id: string, reason: string, req: Request) {
    const transfer = await this.loadFor(auth, id);
    this.organizations.resolveActingOrganization(auth, transfer.organizationId, Permission.TRANSFER_CREATE);
    if (transfer.status !== 'QUOTED' && transfer.status !== 'REVIEW_REQUIRED') {
      throw DomainError.invalidTransition(`A ${transfer.status} transfer cannot be cancelled`, {
        entity: 'Transfer',
        from: transfer.status,
        to: 'CANCELLED',
      });
    }
    transferMachine.assertTransition(transfer.status, 'CANCELLED');
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      const [locked] = await db.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM "Transfer" WHERE id = ${transfer.id}::uuid FOR UPDATE`;
      if (!locked || (locked.status !== 'QUOTED' && locked.status !== 'REVIEW_REQUIRED')) {
        throw DomainError.invalidTransition('Transfer can no longer be cancelled', {
          entity: 'Transfer',
          from: locked?.status ?? 'UNKNOWN',
          to: 'CANCELLED',
        });
      }
      await db.transfer.update({
        where: { id: transfer.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          metadata: { ...metadataOf(transfer), cancelReason: reason, cancelledByUserId: auth.userId },
        },
      });
      await this.recordEvent(db, transfer.id, TransferEventType.CANCELLED, auth.userId, {
        reason,
        from: locked.status,
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: transfer.organizationId,
          action: 'transfer.cancelled',
          entityType: 'Transfer',
          entityId: transfer.id,
          metadata: { reference: transfer.reference, reason, from: locked.status },
          ...meta,
        },
        db,
      );
    });
    const full = await this.reload(transfer.id);
    await this.notifyTransfer(
      full,
      'transfer.cancelled',
      `Transfert annulé — ${full.reference}`,
      `Le transfert de ${this.describe(full)} a été annulé par ${auth.firstName} ${auth.lastName} : ${reason}. Aucun fonds fictif n'a été débité.`,
    );
    return toTransferDto(full, this.viewerFor(auth, full));
  }

  // ───────────────────────────── Reads ─────────────────────────────

  async list(auth: AuthContext, query: ListTransfersQuery) {
    let organizationIds: string[];
    if (query.organizationId) {
      if (!isStaff(auth) && !membershipFor(auth, query.organizationId))
        throw DomainError.notFound('Organization');
      organizationIds = [query.organizationId];
    } else {
      organizationIds = auth.memberships.map((m) => m.organizationId);
    }
    await this.expireStaleTransfers(organizationIds);
    const where: Prisma.TransferWhereInput = {
      organizationId: { in: organizationIds },
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: TRANSFER_INCLUDE,
      }),
      this.prisma.transfer.count({ where }),
    ]);
    return {
      ...paginate(
        items.map((t) => toTransferSummary(t, { isStaff: isStaff(auth) })),
        total,
        query.page,
        query.pageSize,
      ),
      simulated: true,
      disclaimer: TRANSFER_DISCLAIMER_FR,
    };
  }

  async get(auth: AuthContext, id: string) {
    const transfer = await this.loadFor(auth, id);
    return toTransferDto(transfer, this.viewerFor(auth, transfer));
  }

  async receipt(auth: AuthContext, id: string, format: 'json' | 'txt') {
    const transfer = await this.loadFor(auth, id);
    if (!['PROCESSING', 'SETTLED', 'FAILED'].includes(transfer.status)) {
      throw DomainError.invalidTransition(
        'A receipt is only available once the transfer has been authorised',
        {
          entity: 'Transfer',
          from: transfer.status,
          to: 'RECEIPT',
        },
      );
    }
    const receipt = toTransferReceipt(transfer);
    if (format === 'txt') return receiptToText(receipt);
    return receipt;
  }

  // ───────────────────────────── Admin ─────────────────────────────

  async adminList(query: ListTransfersQuery) {
    const where: Prisma.TransferWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.organizationId ? { organizationId: query.organizationId } : {}),
    };
    const [items, total, reviewQueue] = await Promise.all([
      this.prisma.transfer.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: TRANSFER_INCLUDE,
      }),
      this.prisma.transfer.count({ where }),
      this.prisma.transfer.count({ where: { status: 'REVIEW_REQUIRED' } }),
    ]);
    return {
      ...paginate(
        items.map((t) => ({
          ...toTransferSummary(t, { isStaff: true }),
          createdBy: t.createdBy
            ? {
                id: t.createdBy.id,
                email: t.createdBy.email,
                name: `${t.createdBy.firstName} ${t.createdBy.lastName}`,
              }
            : null,
          reviewReason: t.reviewReason,
          reviewedAt: t.reviewedAt,
          failureReason: t.failureReason,
          authorizedAt: t.authorizedAt,
          processingAt: t.processingAt,
        })),
        total,
        query.page,
        query.pageSize,
      ),
      reviewQueue,
      simulated: true,
      disclaimer: TRANSFER_DISCLAIMER_FR,
    };
  }

  async adminReview(auth: AuthContext, id: string, input: ReviewTransferInput, req: Request) {
    const transfer = await this.prisma.transfer.findUnique({ where: { id }, include: TRANSFER_INCLUDE });
    if (!transfer) throw DomainError.notFound('Transfer');
    if (transfer.status !== 'REVIEW_REQUIRED') {
      throw DomainError.invalidTransition('Only transfers awaiting review can be reviewed', {
        entity: 'Transfer',
        from: transfer.status,
        to: input.decision === 'APPROVE' ? 'AUTHORIZED' : 'CANCELLED',
      });
    }
    const meta = requestMeta(req);
    if (input.decision === 'APPROVE') {
      transferMachine.assertTransition('REVIEW_REQUIRED', 'AUTHORIZED');
      const posted = await this.postSourceLeg(transfer, auth.userId, {
        via: 'REVIEW_APPROVE',
        riskScore: transfer.riskScore,
        reviewNote: input.note,
        ...meta,
      });
      await this.notifyTransfer(
        posted,
        'transfer.review_approved',
        `Transfert approuvé — en traitement (simulé) — ${posted.reference}`,
        `L'équipe conformité a approuvé le transfert de ${this.describe(posted)}. ${minorToDecimalString(posted.sourceAmountMinor + posted.feeMinor, posted.sourceCurrency)} ${posted.sourceCurrency} fictifs ont été débités du portefeuille.`,
      );
      return toTransferDto(posted, this.viewerFor(auth, posted));
    }
    transferMachine.assertTransition('REVIEW_REQUIRED', 'CANCELLED');
    await this.prisma.$transaction(async (db) => {
      const [locked] = await db.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM "Transfer" WHERE id = ${transfer.id}::uuid FOR UPDATE`;
      if (!locked || locked.status !== 'REVIEW_REQUIRED') {
        throw DomainError.invalidTransition('Transfer is no longer awaiting review', {
          entity: 'Transfer',
          from: locked?.status ?? 'UNKNOWN',
          to: 'CANCELLED',
        });
      }
      const now = new Date();
      await db.transfer.update({
        where: { id: transfer.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          reviewedByUserId: auth.userId,
          reviewedAt: now,
          metadata: {
            ...metadataOf(transfer),
            reviewNote: input.note,
            cancelReason: input.note,
            rejectedByStaff: true,
          },
        },
      });
      await this.recordEvent(db, transfer.id, TransferEventType.REVIEW_REJECTED, auth.userId, {
        note: input.note,
      });
      await this.recordEvent(db, transfer.id, TransferEventType.CANCELLED, auth.userId, {
        reason: input.note,
        from: 'REVIEW_REQUIRED',
        byStaff: true,
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: transfer.organizationId,
          action: 'transfer.review_rejected',
          entityType: 'Transfer',
          entityId: transfer.id,
          metadata: { reference: transfer.reference, note: input.note },
          ...meta,
        },
        db,
      );
    });
    const full = await this.reload(transfer.id);
    await this.notifyTransfer(
      full,
      'transfer.review_rejected',
      `Transfert refusé par la conformité — ${full.reference}`,
      `Le transfert de ${this.describe(full)} a été refusé : ${input.note}. Aucun fonds fictif n'a été débité.`,
    );
    return toTransferDto(full, this.viewerFor(auth, full));
  }

  // ───────────────────────────── Maintenance job ─────────────────────────────

  /** TRANSFER_PROCESSING: sandbox auto-settlement of PROCESSING transfers + expiry of stale quotes. */
  async processingJob(triggeredBy: string): Promise<JobResult> {
    const cutoff = new Date(Date.now() - SANDBOX_AUTO_SETTLE_AFTER_MS);
    const due = await this.prisma.transfer.findMany({
      where: { status: 'PROCESSING', processingAt: { lt: cutoff } },
      select: { id: true, reference: true },
      orderBy: { processingAt: 'asc' },
    });
    let settled = 0;
    const failed: string[] = [];
    for (const t of due) {
      try {
        const r = await this.handlePartnerOutcome(t.id, 'SETTLED', {
          actorUserId: null,
          triggeredBy: `job:${triggeredBy}`,
        });
        if (!r.replayed && r.status === 'PROCESSED') settled++;
      } catch (err) {
        failed.push(t.reference);
        this.logger.error(
          `auto-settlement of ${t.reference} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const expired = await this.expireStaleTransfers();
    return {
      summary: {
        due: due.length,
        settled,
        failed: failed.length,
        failedReferences: failed,
        expired,
        autoSettleAfterMs: SANDBOX_AUTO_SETTLE_AFTER_MS,
        cutoff: cutoff.toISOString(),
      },
    };
  }

  /** Helper for controllers: the viewer may act on the sandbox partner events of this transfer. */
  assertPartnerSimulationAllowed(auth: AuthContext, transfer: Pick<Transfer, 'organizationId'>) {
    if (globalRoleHas(auth.globalRole, Permission.SANDBOX_PARTNER_SIMULATE)) return;
    const membership = membershipFor(auth, transfer.organizationId);
    if (!membership && isStaff(auth)) {
      throw DomainError.forbidden('Simulating partner events requires the sandbox partner permission');
    }
    if (!membership) throw DomainError.notFound('Transfer');
    if (!orgRoleHas(membership.role, Permission.TRANSFER_CREATE)) {
      throw DomainError.forbidden(`Your role (${membership.role}) does not allow simulating partner events`);
    }
  }
}
