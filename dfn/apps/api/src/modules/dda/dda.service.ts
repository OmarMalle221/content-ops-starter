import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { DdaOperation, DigitalAssetSimStatus, Prisma, PrismaTransactionClient } from '@dfn/database';
import { LedgerService, type PostedTransaction } from '@dfn/financial-ledger';
import {
  ddaReferenceSchema,
  parseDecimalToMinor,
  type DdaMintInput,
  type DdaRedeemInput,
  type DdaReserveAdjustmentInput,
  type DdaStressTestInput,
  type DdaTransferInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { randomToken } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { moneyDto } from '../../common/serialize';
import { staffUserWhere } from '../../common/staff-recipients';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { LEDGER } from '../ledger/ledger.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { DdaRegistryService, type DdaHoldingBalance } from './dda-registry.service';
import { coverageRatioBps, runStressTest } from './dda-stress';
import { DDA, DDA_DEFINITION, DDA_METADATA, DDA_RESERVE_CURRENCY, ddaEnvelope } from './dda.constants';
import {
  DDA_OPERATION_INCLUDE,
  ddaOperationDto,
  type DdaOperationRow,
  type OrganizationRef,
} from './dda.dto';

type Db = PrismaTransactionClient | PrismaService;

/**
 * Mint / transfer / redeem simulators, simulated reserve, coverage and stress testing of the
 * fictitious Diaspora Digital Asset. Admin-only (Permission.ADMIN_DDA). Every money-like movement
 * of units is a balanced ledger posting in the 'DDA' currency; the simulated USD reserve is
 * deliberately kept OFF the fiat ledger (Σ reserveDeltaUsdMinor of the simulation rows) so that no
 * path can ever connect fictitious units to fiat accounts.
 */
@Injectable()
export class DdaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    private readonly registry: DdaRegistryService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────────────────────── Simulators ─────────────────────────────

  async mint(auth: AuthContext, input: DdaMintInput, req: Request) {
    this.registry.assertDdaCurrency(input.currencyCode);
    const org = await this.loadOrganization(input.organizationId);
    const units = this.parseUnits(input.units);
    const reserve = input.reserveUsd ? parseDecimalToMinor(input.reserveUsd, DDA_RESERVE_CURRENCY) : 0n;
    const meta = requestMeta(req);
    const row = await this.prisma.$transaction(async (db) => {
      const issuance = await this.registry.ensure(db);
      const holding = await this.registry.ensureHolding(org.id, db);
      const reference = await this.generateReference(db);
      const posted = await this.ledger.post(
        {
          idempotencyKey: `dda:${reference}`,
          kind: 'DEPOSIT',
          description: `DDA mint ${reference} → ${org.name} — fictitious units (research simulation)`,
          reference,
          metadata: { ...DDA_METADATA, operation: 'MINT', organizationId: org.id },
          entries: [
            { accountId: issuance.id, direction: 'DEBIT', amountMinor: units, currencyCode: DDA },
            { accountId: holding.id, direction: 'CREDIT', amountMinor: units, currencyCode: DDA },
          ],
        },
        db,
      );
      return this.persist(
        db,
        auth,
        {
          reference,
          organizationId: org.id,
          operation: 'MINT',
          status: 'MINTED',
          unitsMinor: units,
          reserveDeltaUsdMinor: reserve,
          note: input.note,
        },
        posted,
        'dda.mint',
        meta,
      );
    });
    await this.notifyAdmins(row, `Émission simulée de ${row.units?.decimal} DDA pour « ${org.name} »`);
    return ddaEnvelope(row);
  }

  async transfer(auth: AuthContext, input: DdaTransferInput, req: Request) {
    this.registry.assertDdaCurrency(input.currencyCode);
    if (input.fromOrganizationId === input.toOrganizationId) {
      throw DomainError.validation('Source and destination organisations must differ');
    }
    const [from, to] = await Promise.all([
      this.loadOrganization(input.fromOrganizationId),
      this.loadOrganization(input.toOrganizationId),
    ]);
    const units = this.parseUnits(input.units);
    const meta = requestMeta(req);
    const row = await this.prisma.$transaction(async (db) => {
      await this.registry.ensure(db);
      const source = await this.registry.ensureHolding(from.id, db);
      const destination = await this.registry.ensureHolding(to.id, db);
      const reference = await this.generateReference(db);
      // INSUFFICIENT_FUNDS is raised by the ledger under lock and surfaces as HTTP 409.
      const posted = await this.ledger.post(
        {
          idempotencyKey: `dda:${reference}`,
          kind: 'ADJUSTMENT',
          description: `DDA transfer ${reference} ${from.name} → ${to.name} — fictitious units (research simulation)`,
          reference,
          metadata: {
            ...DDA_METADATA,
            operation: 'TRANSFER',
            fromOrganizationId: from.id,
            toOrganizationId: to.id,
          },
          entries: [
            { accountId: source.id, direction: 'DEBIT', amountMinor: units, currencyCode: DDA },
            { accountId: destination.id, direction: 'CREDIT', amountMinor: units, currencyCode: DDA },
          ],
        },
        db,
      );
      return this.persist(
        db,
        auth,
        {
          reference,
          organizationId: from.id,
          counterpartyOrganizationId: to.id,
          operation: 'TRANSFER',
          status: 'TRANSFERRED',
          unitsMinor: units,
          reserveDeltaUsdMinor: 0n,
          note: input.note,
        },
        posted,
        'dda.transfer',
        meta,
      );
    });
    await this.notifyAdmins(
      row,
      `Transfert simulé de ${row.units?.decimal} DDA de « ${from.name} » vers « ${to.name} »`,
    );
    return ddaEnvelope(row);
  }

  async redeem(auth: AuthContext, input: DdaRedeemInput, req: Request) {
    this.registry.assertDdaCurrency(input.currencyCode);
    const org = await this.loadOrganization(input.organizationId);
    const units = this.parseUnits(input.units);
    const meta = requestMeta(req);
    const row = await this.prisma.$transaction(async (db) => {
      const issuance = await this.registry.ensure(db);
      const holding = await this.registry.ensureHolding(org.id, db);
      const reference = await this.generateReference(db);
      const posted = await this.ledger.post(
        {
          idempotencyKey: `dda:${reference}`,
          kind: 'WITHDRAWAL',
          description: `DDA redeem ${reference} ← ${org.name} — fictitious units destroyed (research simulation, no fiat paid out)`,
          reference,
          metadata: { ...DDA_METADATA, operation: 'REDEEM', organizationId: org.id, fiatPayout: 'NONE' },
          entries: [
            { accountId: holding.id, direction: 'DEBIT', amountMinor: units, currencyCode: DDA },
            { accountId: issuance.id, direction: 'CREDIT', amountMinor: units, currencyCode: DDA },
          ],
        },
        db,
      );
      return this.persist(
        db,
        auth,
        {
          reference,
          organizationId: org.id,
          operation: 'REDEEM',
          status: 'REDEEMED',
          unitsMinor: units,
          reserveDeltaUsdMinor: 0n,
          note: input.note,
        },
        posted,
        'dda.redeem',
        meta,
      );
    });
    await this.notifyAdmins(row, `Rachat simulé de ${row.units?.decimal} DDA de « ${org.name} »`);
    return ddaEnvelope(row);
  }

  /**
   * Simulated reserve movement (±). Persisted as a DigitalAssetSimulation row only — never as a
   * posting on the fiat ledger (red line: fictitious units must not connect to fiat accounts).
   * The schema requires an organisation on every row, so the acting admin's personal workspace is
   * used as the booking workspace; the operation itself is platform-scoped.
   */
  async adjustReserve(auth: AuthContext, input: DdaReserveAdjustmentInput, req: Request) {
    const delta = this.parseSignedUsd(input.deltaUsd);
    const bookingOrganizationId = this.reserveBookingOrganization(auth);
    const meta = requestMeta(req);
    const row = await this.prisma.$transaction(async (db) => {
      await this.registry.ensure(db);
      // Serialise concurrent adjustments so the "never negative" rule holds under load.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dda:reserve'))`;
      const current = await this.reserveUsdMinor(db);
      if (current + delta < 0n) {
        throw new DomainError(
          'DDA_RESERVE_NEGATIVE',
          'The simulated reserve cannot become negative',
          HttpStatus.CONFLICT,
          { reserveUsdMinor: current.toString(), deltaUsdMinor: delta.toString() },
        );
      }
      const reference = await this.generateReference(db);
      return this.persist(
        db,
        auth,
        {
          reference,
          organizationId: bookingOrganizationId,
          operation: 'RESERVE_ADJUSTMENT',
          status: delta > 0n ? 'MINTED' : 'REDEEMED',
          unitsMinor: 0n,
          reserveDeltaUsdMinor: delta,
          note: input.note,
          extraMetadata: {
            scope: 'PLATFORM_RESERVE',
            offFiatLedger: true,
            bookingOrganizationId,
            reserveBeforeUsdMinor: current.toString(),
            reserveAfterUsdMinor: (current + delta).toString(),
          },
        },
        null,
        'dda.reserve_adjustment',
        meta,
      );
    });
    await this.notifyAdmins(
      row,
      `Ajustement de la réserve simulée : ${delta > 0n ? '+' : ''}${row.reserveDeltaUsd?.decimal} USD fictifs`,
    );
    return ddaEnvelope(row);
  }

  // ───────────────────────────── Read models ─────────────────────────────

  async overview() {
    await this.registry.ensure();
    const [supply, holdings, reserve, operationsCount, lastOperations] = await Promise.all([
      this.registry.supplyMinor(),
      this.registry.holdings(),
      this.reserveUsdMinor(),
      this.prisma.digitalAssetSimulation.count(),
      this.prisma.digitalAssetSimulation.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: DDA_OPERATION_INCLUDE,
      }),
    ]);
    const sumHoldings = holdings.reduce((acc, h) => acc + h.balanceMinor, 0n);
    const positive = holdings.filter((h) => h.balanceMinor > 0n);
    const top = await this.decorateHoldings(positive.slice(0, 10), supply);
    return ddaEnvelope({
      currency: {
        code: DDA,
        name: DDA_DEFINITION.name,
        exponent: DDA_DEFINITION.exponent,
        kind: 'SIMULATED_ASSET' as const,
      },
      supply: moneyDto(supply, DDA),
      sumHoldings: moneyDto(sumHoldings, DDA),
      invariantHolds: supply === sumHoldings,
      reserveUsd: moneyDto(reserve, DDA_RESERVE_CURRENCY),
      coverageRatioBps: coverageRatioBps(supply, reserve),
      holdersCount: positive.length,
      topHoldings: top,
      operationsCount,
      lastOperations: lastOperations.map((row) => ddaOperationDto(row as DdaOperationRow)),
      redLines: [
        'Aucune blockchain publique ni privée, aucun jeton.',
        'Aucun fonds réel ; aucune conversion du DDA en monnaie ou en actif.',
        'Aucune exposition aux utilisateurs non administrateurs.',
        'Parité 1 DDA = 1 USD : hypothèse de recherche, jamais une garantie.',
      ],
    });
  }

  async holdings() {
    await this.registry.ensure();
    const [supply, holdings] = await Promise.all([this.registry.supplyMinor(), this.registry.holdings()]);
    const items = await this.decorateHoldings(holdings, supply);
    const sumHoldings = holdings.reduce((acc, h) => acc + h.balanceMinor, 0n);
    return ddaEnvelope({
      supply: moneyDto(supply, DDA),
      sumHoldings: moneyDto(sumHoldings, DDA),
      invariantHolds: supply === sumHoldings,
      items,
      total: items.length,
    });
  }

  async operations(page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      this.prisma.digitalAssetSimulation.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: DDA_OPERATION_INCLUDE,
      }),
      this.prisma.digitalAssetSimulation.count(),
    ]);
    return ddaEnvelope({
      items: items.map((row) => ddaOperationDto(row as DdaOperationRow)),
      total,
      page,
      pageSize,
    });
  }

  /** Organisation picker for the simulators (admin only — never exposed to tenants). */
  async organizations() {
    const items = await this.prisma.organization.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, type: true, country: true },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
    return ddaEnvelope({ items, total: items.length });
  }

  /** Pure computation on the current supply and simulated reserve: nothing is written. */
  async stressTest(input: DdaStressTestInput) {
    await this.registry.ensure();
    const [supply, reserve] = await Promise.all([this.registry.supplyMinor(), this.reserveUsdMinor()]);
    const result = runStressTest({
      supplyMinor: supply,
      reserveUsdMinor: reserve,
      redemptionPercent: input.redemptionPercent,
      reserveHaircutPercent: input.reserveHaircutPercent,
    });
    return ddaEnvelope({
      inputs: {
        redemptionPercent: input.redemptionPercent,
        reserveHaircutPercent: input.reserveHaircutPercent,
        redemptionBps: result.redemptionBps,
        reserveHaircutBps: result.reserveHaircutBps,
      },
      supply: moneyDto(supply, DDA),
      reserveUsd: moneyDto(reserve, DDA_RESERVE_CURRENCY),
      coverageBeforeBps: result.coverageBeforeBps,
      redeemedUnits: moneyDto(result.redeemedUnitsMinor, DDA),
      remainingSupply: moneyDto(result.remainingSupplyMinor, DDA),
      reserveAfterHaircut: moneyDto(result.reserveAfterHaircutMinor, DDA_RESERVE_CURRENCY),
      reserveAfterRedemptions: moneyDto(result.reserveAfterRedemptionsMinor, DDA_RESERVE_CURRENCY),
      shortfallUsd: moneyDto(result.shortfallUsdMinor, DDA_RESERVE_CURRENCY),
      coverageAfterBps: result.coverageAfterBps,
      verdict: result.verdict,
      notes: result.notes,
    });
  }

  /** Full traceability of one operation: simulation row, ledger posting and audit trail. */
  async trace(reference: string) {
    if (!ddaReferenceSchema.safeParse(reference).success) throw DomainError.notFound('DDA operation');
    const row = await this.prisma.digitalAssetSimulation.findUnique({
      where: { reference },
      include: DDA_OPERATION_INCLUDE,
    });
    if (!row) throw DomainError.notFound('DDA operation');
    const [ledgerTransaction, auditRows] = await Promise.all([
      row.ledgerTransactionId
        ? this.prisma.ledgerTransaction.findUnique({
            where: { id: row.ledgerTransactionId },
            include: {
              entries: {
                orderBy: { createdAt: 'asc' },
                include: {
                  account: {
                    select: {
                      id: true,
                      code: true,
                      name: true,
                      type: true,
                      normalBalance: true,
                      currencyCode: true,
                      ownerType: true,
                      ownerId: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve(null),
      this.prisma.auditLog.findMany({
        where: { entityType: 'DigitalAssetSimulation', entityId: row.id },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
    ]);
    return ddaEnvelope({
      operation: ddaOperationDto(row as DdaOperationRow),
      ledgerTransaction: ledgerTransaction
        ? {
            id: ledgerTransaction.id,
            idempotencyKey: ledgerTransaction.idempotencyKey,
            kind: ledgerTransaction.kind,
            status: ledgerTransaction.status,
            description: ledgerTransaction.description,
            reference: ledgerTransaction.reference,
            metadata: ledgerTransaction.metadata,
            postedAt: ledgerTransaction.postedAt,
            entries: ledgerTransaction.entries.map((e) => ({
              id: e.id,
              direction: e.direction,
              amount: moneyDto(e.amountMinor, e.currencyCode),
              account: e.account,
              createdAt: e.createdAt,
            })),
          }
        : null,
      audit: auditRows.map((a) => ({
        id: a.id,
        action: a.action,
        actor: a.actor,
        organizationId: a.organizationId,
        metadata: a.metadata,
        ip: a.ip,
        createdAt: a.createdAt,
      })),
    });
  }

  // ───────────────────────────── Internals ─────────────────────────────

  /** Simulated reserve = Σ reserveDeltaUsdMinor (mints with reserve + adjustments). */
  async reserveUsdMinor(db: Db = this.prisma): Promise<bigint> {
    const agg = await db.digitalAssetSimulation.aggregate({ _sum: { reserveDeltaUsdMinor: true } });
    return agg._sum.reserveDeltaUsdMinor ?? 0n;
  }

  private async persist(
    db: PrismaTransactionClient,
    auth: AuthContext,
    data: {
      reference: string;
      organizationId: string;
      counterpartyOrganizationId?: string;
      operation: DdaOperation;
      status: DigitalAssetSimStatus;
      unitsMinor: bigint;
      reserveDeltaUsdMinor: bigint;
      note?: string;
      extraMetadata?: Record<string, unknown>;
    },
    posted: PostedTransaction | null,
    action: string,
    meta: { ip?: string; userAgent?: string },
  ) {
    const metadata = {
      ...DDA_METADATA,
      operation: data.operation,
      ledgerKind: posted?.kind ?? null,
      ledgerEntries: posted?.entries.length ?? 0,
      ...(data.extraMetadata ?? {}),
    } as Prisma.InputJsonValue;
    const created = await db.digitalAssetSimulation.create({
      data: {
        reference: data.reference,
        organizationId: data.organizationId,
        counterpartyOrganizationId: data.counterpartyOrganizationId ?? null,
        createdByUserId: auth.userId,
        operation: data.operation,
        status: data.status,
        unitsMinor: data.unitsMinor,
        reserveDeltaUsdMinor: data.reserveDeltaUsdMinor,
        ledgerTransactionId: posted?.id ?? null,
        note: data.note?.trim() ? data.note.trim() : null,
        metadata,
      },
      include: DDA_OPERATION_INCLUDE,
    });
    await this.audit.log(
      {
        actorUserId: auth.userId,
        organizationId: data.operation === 'RESERVE_ADJUSTMENT' ? null : data.organizationId,
        action,
        entityType: 'DigitalAssetSimulation',
        entityId: created.id,
        metadata: {
          ...DDA_METADATA,
          reference: data.reference,
          operation: data.operation,
          unitsMinor: data.unitsMinor.toString(),
          reserveDeltaUsdMinor: data.reserveDeltaUsdMinor.toString(),
          counterpartyOrganizationId: data.counterpartyOrganizationId ?? null,
          ledgerTransactionId: posted?.id ?? null,
        },
        ...meta,
      },
      db,
    );
    return ddaOperationDto(created as DdaOperationRow);
  }

  /** Red line: DDA never reaches tenants — only platform administrators are informed. */
  private async notifyAdmins(row: ReturnType<typeof ddaOperationDto>, summary: string) {
    const admins = await this.prisma.user.findMany({
      where: staffUserWhere(this.env, ['ADMIN']),
      select: { id: true },
    });
    await this.notifications.notifyMany(
      admins.map((a) => a.id),
      {
        type: 'dda.operation',
        title: `Laboratoire DDA — ${row.reference}`,
        body: `${summary}. Simulation de recherche : unités fictives, parité 1 DDA = 1 USD non garantie, aucun fonds réel.`,
        data: { reference: row.reference, operation: row.operation, simulated: true },
      },
    );
  }

  private async loadOrganization(id: string, db: Db = this.prisma): Promise<OrganizationRef> {
    const org = await db.organization.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    if (!org) throw DomainError.notFound('Organization');
    return org;
  }

  private parseUnits(value: string): bigint {
    let minor: bigint;
    try {
      minor = parseDecimalToMinor(value, DDA);
    } catch {
      throw DomainError.validation(`Invalid amount of units: ${value}`);
    }
    if (minor <= 0n) throw DomainError.validation('Units must be greater than zero');
    return minor;
  }

  private parseSignedUsd(value: string): bigint {
    const trimmed = value.trim();
    const negative = trimmed.startsWith('-');
    let minor: bigint;
    try {
      minor = parseDecimalToMinor(negative ? trimmed.slice(1) : trimmed, DDA_RESERVE_CURRENCY);
    } catch {
      throw DomainError.validation(`Invalid reserve delta: ${value}`);
    }
    if (minor === 0n) throw DomainError.validation('Reserve delta must not be zero');
    return negative ? -minor : minor;
  }

  private reserveBookingOrganization(auth: AuthContext): string {
    const personal = auth.memberships.find((m) => m.organizationType === 'PERSONAL') ?? auth.memberships[0];
    if (!personal) {
      throw DomainError.conflict(
        'Reserve adjustments are booked against the acting administrator workspace; none was found',
      );
    }
    return personal.organizationId;
  }

  private async generateReference(db: PrismaTransactionClient): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = `DDA-${new Date().getUTCFullYear()}-${randomToken(6)
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase()
        .padEnd(6, '7')
        .slice(0, 6)}`;
      const exists = await db.digitalAssetSimulation.findUnique({
        where: { reference: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw DomainError.conflict('Could not allocate a DDA reference');
  }

  private async decorateHoldings(holdings: DdaHoldingBalance[], supply: bigint) {
    const ids = holdings.map((h) => h.organizationId);
    const orgs = ids.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, type: true, country: true, deletedAt: true },
        })
      : [];
    const byId = new Map(orgs.map((o) => [o.id, o]));
    return holdings.map((h) => {
      const org = byId.get(h.organizationId);
      return {
        accountId: h.accountId,
        accountCode: h.accountCode,
        organization: org
          ? { id: org.id, name: org.name, type: org.type, country: org.country, deleted: !!org.deletedAt }
          : { id: h.organizationId, name: h.organizationId, type: null, country: null, deleted: true },
        balance: moneyDto(h.balanceMinor, DDA),
        shareBps: supply > 0n ? Number((h.balanceMinor * 10_000n) / supply) : 0,
        entryCount: h.entryCount,
      };
    });
  }
}
