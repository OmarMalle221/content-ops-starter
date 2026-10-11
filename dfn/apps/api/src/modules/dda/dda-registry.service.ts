import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { LedgerAccount, PrismaTransactionClient } from '@dfn/database';
import { LedgerService, ddaHoldingCode, ddaIssuanceCode } from '@dfn/financial-ledger';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LEDGER } from '../ledger/ledger.provider';
import { DDA, DDA_DEFINITION } from './dda.constants';

type Db = PrismaTransactionClient | PrismaService;

export interface DdaHoldingBalance {
  accountId: string;
  accountCode: string;
  organizationId: string;
  balanceMinor: bigint;
  entryCount: number;
}

/**
 * Registry of the fictitious DDA units on the double-entry ledger.
 *
 *  ASSET (contra) DDA_ISSUANCE:DDA               — allowNegative, PLATFORM: balance = units in circulation
 *  LIABILITY      DDA_HOLDING:<organizationId>:DDA — per organisation, never negative
 *
 *  MINT     = DEBIT issuance  / CREDIT holding
 *  REDEEM   = DEBIT holding   / CREDIT issuance
 *  TRANSFER = DEBIT holding A / CREDIT holding B
 *
 * Invariant: supply = balance(DDA_ISSUANCE) = Σ balance(DDA_HOLDING:*). All postings share the single
 * currency 'DDA' (kind SIMULATED_ASSET): nothing here ever touches a fiat account.
 */
@Injectable()
export class DdaRegistryService implements OnModuleInit {
  private readonly logger = new Logger(DdaRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
  ) {}

  async onModuleInit() {
    await this.ensure();
    this.logger.log('DDA research registry ready (fictitious units — no real issuance)');
  }

  /** Idempotent: upserts the simulated currency and the issuance account. Safe to call before every operation. */
  async ensure(db: Db = this.prisma): Promise<LedgerAccount> {
    await db.currency.upsert({
      where: { code: DDA },
      update: {
        name: DDA_DEFINITION.name,
        exponent: DDA_DEFINITION.exponent,
        symbol: DDA_DEFINITION.symbol,
        kind: 'SIMULATED_ASSET',
        isActive: true,
      },
      create: {
        code: DDA,
        name: DDA_DEFINITION.name,
        exponent: DDA_DEFINITION.exponent,
        symbol: DDA_DEFINITION.symbol,
        kind: 'SIMULATED_ASSET',
        isActive: true,
      },
    });
    const issuance = await this.ledger.ensureAccount(
      {
        code: ddaIssuanceCode(),
        name: 'DDA issuance — fictitious units (research simulation)',
        type: 'ASSET',
        normalBalance: 'DEBIT',
        currencyCode: DDA,
        ownerType: 'PLATFORM',
        allowNegative: true,
      },
      db,
    );
    return this.assertDdaAccount(issuance);
  }

  /** Holding account of an organisation, created lazily on first use. */
  async ensureHolding(organizationId: string, db: Db = this.prisma): Promise<LedgerAccount> {
    const account = await this.ledger.ensureAccount(
      {
        code: ddaHoldingCode(organizationId),
        name: `DDA holding ${organizationId} — fictitious units`,
        type: 'LIABILITY',
        normalBalance: 'CREDIT',
        currencyCode: DDA,
        ownerType: 'ORGANIZATION',
        ownerId: organizationId,
        allowNegative: false,
      },
      db,
    );
    return this.assertDdaAccount(account);
  }

  /** Red line: the registry only ever operates in the simulated asset currency. */
  assertDdaCurrency(currencyCode: string | undefined | null): void {
    if (currencyCode !== undefined && currencyCode !== null && currencyCode !== DDA) {
      throw new DomainError(
        'DDA_CURRENCY_REQUIRED',
        `DDA operations are only allowed in ${DDA} (received ${currencyCode})`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertDdaAccount(account: LedgerAccount): LedgerAccount {
    if (account.currencyCode !== DDA) {
      throw new DomainError(
        'DDA_CURRENCY_MISMATCH',
        `Ledger account ${account.code} is denominated in ${account.currencyCode}, expected ${DDA}`,
        HttpStatus.CONFLICT,
      );
    }
    return account;
  }

  /** Units in circulation = balance of the issuance account (DEBIT normal). */
  async supplyMinor(db: Db = this.prisma): Promise<bigint> {
    const account = await this.ledger.getAccountByCode(ddaIssuanceCode(), db);
    if (!account) return 0n;
    return (await this.ledger.getBalance(account.id, db)).balanceMinor;
  }

  /** Balance of every holding account (one aggregate query), highest first. */
  async holdings(db: Db = this.prisma): Promise<DdaHoldingBalance[]> {
    const prefix = 'DDA_HOLDING:';
    const rows = await db.$queryRaw<
      Array<{ id: string; code: string; ownerId: string | null; balance: bigint; count: bigint }>
    >`
      SELECT a.id, a.code, a."ownerId",
        COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e."amountMinor" ELSE -e."amountMinor" END), 0)::bigint AS balance,
        COUNT(e.id)::bigint AS count
      FROM "LedgerAccount" a
      LEFT JOIN "LedgerEntry" e ON e."accountId" = a.id
      WHERE a."currencyCode" = ${DDA} AND a.code LIKE ${prefix + '%'} AND a."ownerType" = 'ORGANIZATION'
      GROUP BY a.id, a.code, a."ownerId"
      ORDER BY balance DESC, a.code ASC`;
    return rows
      .filter((r) => r.ownerId)
      .map((r) => ({
        accountId: r.id,
        accountCode: r.code,
        organizationId: r.ownerId!,
        balanceMinor: BigInt(r.balance ?? 0),
        entryCount: Number(r.count ?? 0),
      }));
  }
}
