import { Inject, Injectable } from '@nestjs/common';
import type { PrismaTransactionClient } from '@dfn/database';
import { LedgerService, walletAccountCode } from '@dfn/financial-ledger';
import { CURRENCIES, minorToDecimalString } from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LEDGER } from './ledger.provider';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
  ) {}

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
    return db.wallet.create({ data: { organizationId, currencyCode, ledgerAccountId: account.id } });
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
      disclaimer: 'Données fictives — Aucun fonds réel',
      wallets: result,
    };
  }

  async entries(
    auth: AuthContext,
    organizationId: string,
    currencyCode: string,
    page: number,
    pageSize: number,
  ) {
    this.assertAccess(auth, organizationId);
    const wallet = await this.prisma.wallet.findUnique({
      where: { organizationId_currencyCode: { organizationId, currencyCode } },
    });
    if (!wallet) return { items: [], total: 0, page, pageSize };
    const r = await this.ledger.listEntries(wallet.ledgerAccountId, page, pageSize);
    return {
      ...r,
      items: r.items.map((e) => ({
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
    };
  }

  async statementCsv(auth: AuthContext, organizationId: string, currencyCode: string) {
    const all = await this.entries(auth, organizationId, currencyCode, 1, 100);
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
    return [
      '# Diaspora Trust — SANDBOX statement. Données fictives — Aucun fonds réel',
      header,
      ...rows,
    ].join('\n');
  }
}
