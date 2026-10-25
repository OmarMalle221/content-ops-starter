import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerService,
  escrowAccountCode,
  platformFeesCode,
  providerSettlementCode,
  validateEntries,
  walletAccountCode,
  type EntryInstruction,
} from '../src';
import { prisma, resetLedgerTables } from './setup';

/**
 * The guards of the ledger: every refusal below protects an invariant of the double-entry book
 * (balanced postings in one currency, known and active accounts, currency of the account, no
 * negative balance where forbidden) and must fail closed with its stable code.
 */
const db = prisma();
const ledger = new LedgerService(db);

const code = (err: unknown) => (err instanceof LedgerError ? err.code : String(err));

async function accounts() {
  const settlement = await ledger.ensureAccount({
    code: providerSettlementCode('sandbox', 'CAD'),
    name: 'Sandbox partner settlement',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    currencyCode: 'CAD',
    ownerType: 'PROVIDER',
    allowNegative: true,
  });
  const wallet = await ledger.ensureAccount({
    code: walletAccountCode('org-guards', 'CAD'),
    name: 'Wallet org guards',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    currencyCode: 'CAD',
    ownerType: 'ORGANIZATION',
  });
  return { settlement, wallet };
}

const deposit = (from: string, to: string, amountMinor: bigint, key: string) =>
  ledger.post({
    idempotencyKey: key,
    kind: 'DEPOSIT',
    description: 'Simulated deposit (fictitious)',
    entries: [
      { accountId: from, direction: 'DEBIT', amountMinor, currencyCode: 'CAD' },
      { accountId: to, direction: 'CREDIT', amountMinor, currencyCode: 'CAD' },
    ],
  });

beforeEach(async () => {
  await resetLedgerTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('validateEntries (pure, before any database access)', () => {
  const debit: EntryInstruction = {
    accountCode: 'A',
    direction: 'DEBIT',
    amountMinor: 100n,
    currencyCode: 'CAD',
  };
  const credit: EntryInstruction = {
    accountCode: 'B',
    direction: 'CREDIT',
    amountMinor: 100n,
    currencyCode: 'CAD',
  };
  const refusal = (entries: EntryInstruction[]) => {
    try {
      validateEntries(entries);
      return 'accepted';
    } catch (err) {
      return code(err);
    }
  };

  it('accepts a balanced posting in one currency', () => {
    expect(refusal([debit, credit])).toBe('accepted');
  });

  it('refuses fewer than two entries, missing accounts and unknown directions', () => {
    expect(refusal([debit])).toBe('INVALID_POSTING');
    expect(refusal([] as EntryInstruction[])).toBe('INVALID_POSTING');
    expect(refusal([{ ...debit, accountCode: undefined }, credit])).toBe('INVALID_POSTING');
    expect(refusal([{ ...debit, direction: 'SIDEWAYS' as never }, credit])).toBe('INVALID_POSTING');
  });

  it('refuses non-integer, zero and negative amounts', () => {
    expect(refusal([{ ...debit, amountMinor: 100 as never }, credit])).toBe('INVALID_AMOUNT');
    expect(
      refusal([
        { ...debit, amountMinor: 0n },
        { ...credit, amountMinor: 0n },
      ]),
    ).toBe('INVALID_AMOUNT');
    expect(refusal([{ ...debit, amountMinor: -5n }, credit])).toBe('INVALID_AMOUNT');
  });

  it('refuses unbalanced and multi-currency postings', () => {
    expect(refusal([debit, { ...credit, amountMinor: 99n }])).toBe('LEDGER_UNBALANCED');
    expect(refusal([debit, { ...credit, currencyCode: 'XOF' }])).toBe('CURRENCY_MISMATCH');
  });
});

describe('LedgerService guards (database)', () => {
  it('refuses a posting to an unknown account, by code or by id, and writes nothing', async () => {
    const { settlement } = await accounts();
    await expect(
      ledger.post({
        idempotencyKey: 'unknown-code',
        kind: 'DEPOSIT',
        description: 'unknown account',
        entries: [
          { accountId: settlement.id, direction: 'DEBIT', amountMinor: 100n, currencyCode: 'CAD' },
          { accountCode: 'WALLET:nobody:CAD', direction: 'CREDIT', amountMinor: 100n, currencyCode: 'CAD' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await expect(
      deposit(settlement.id, '00000000-0000-4000-8000-000000000000', 100n, 'unknown-id'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it('refuses a posting touching a frozen or closed account', async () => {
    const { settlement, wallet } = await accounts();
    for (const status of ['FROZEN', 'CLOSED'] as const) {
      await db.ledgerAccount.update({ where: { id: wallet.id }, data: { status } });
      await expect(deposit(settlement.id, wallet.id, 100n, `frozen-${status}`)).rejects.toMatchObject({
        code: 'ACCOUNT_FROZEN',
      });
    }
    expect(await db.ledgerEntry.count()).toBe(0);
  });

  it('refuses an entry whose currency differs from its account', async () => {
    const { settlement } = await accounts();
    const xofWallet = await ledger.ensureAccount({
      code: walletAccountCode('org-guards', 'XOF'),
      name: 'Wallet org guards XOF',
      type: 'LIABILITY',
      normalBalance: 'CREDIT',
      currencyCode: 'XOF',
      ownerType: 'ORGANIZATION',
    });
    // Both entries say CAD (the posting itself is consistent) but one account holds XOF.
    await expect(deposit(settlement.id, xofWallet.id, 100n, 'ccy-mismatch')).rejects.toMatchObject({
      code: 'CURRENCY_MISMATCH',
    });
  });

  it('reads balances by id or code, several at once, and pages the entries of an account', async () => {
    const { settlement, wallet } = await accounts();
    for (let i = 1; i <= 3; i++) await deposit(settlement.id, wallet.id, BigInt(i * 1000), `dep-${i}`);
    const byCode = await ledger.getBalance(wallet.code);
    expect(byCode).toMatchObject({
      accountId: wallet.id,
      balanceMinor: 6000n,
      creditsMinor: 6000n,
      entryCount: 3,
    });
    await expect(ledger.getBalance('WALLET:nobody:CAD')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    const both = await ledger.getBalances([settlement.id, wallet.id]);
    expect(Object.fromEntries(both.map((b) => [b.code, b.balanceMinor]))).toEqual({
      [settlement.code]: 6000n,
      [wallet.code]: 6000n,
    });
    expect((await ledger.getAccountByCode(wallet.code))?.id).toBe(wallet.id);
    expect(await ledger.getAccountByCode('WALLET:nobody:CAD')).toBeNull();
    const page1 = await ledger.listEntries(wallet.id, 1, 2);
    const page2 = await ledger.listEntries(wallet.id, 2, 2);
    expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.ledgerTransaction.idempotencyKey).toBe('dep-1');
  });

  it('refuses a snapshot of an unknown account', async () => {
    await expect(ledger.snapshot('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('reconciliation reports a negative balance on an account that forbids it', async () => {
    const { settlement } = await accounts();
    // Negative balances are refused at posting time; this one comes from an account whose
    // allowNegative was revoked afterwards (data the reconciliation must still catch).
    const wallet = await ledger.ensureAccount({
      code: walletAccountCode('org-overdrawn', 'CAD'),
      name: 'Wallet overdrawn',
      type: 'LIABILITY',
      normalBalance: 'CREDIT',
      currencyCode: 'CAD',
      ownerType: 'ORGANIZATION',
      allowNegative: true,
    });
    await deposit(wallet.id, settlement.id, 500n, 'overdraw');
    await db.ledgerAccount.update({ where: { id: wallet.id }, data: { allowNegative: false } });
    const result = await ledger.reconcile();
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        accountId: wallet.id,
        actualMinor: -500n,
        note: expect.stringContaining('Negative balance'),
      }),
    );
    const job = await db.reconciliationJob.findUniqueOrThrow({ where: { id: result.jobId } });
    expect(job.status).not.toBe('FAILED');
  });

  it('builds the stable account codes of the chart of accounts', () => {
    expect(providerSettlementCode('sandbox', 'CAD')).toBe('PROVIDER_SETTLEMENT:SANDBOX:CAD');
    expect(escrowAccountCode('tx-1', 'XOF')).toBe('ESCROW:tx-1:XOF');
    expect(walletAccountCode('org-1', 'EUR')).toBe('WALLET:org-1:EUR');
    expect(platformFeesCode('CAD')).toBe('PLATFORM_FEES:CAD');
  });
});
