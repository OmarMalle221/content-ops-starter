import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerError, LedgerService } from '../src';
import { prisma, resetLedgerTables } from './setup';

const db = prisma();
const ledger = new LedgerService(db);

async function seedAccounts() {
  const settlement = await ledger.ensureAccount({
    code: 'PROVIDER_SETTLEMENT:SANDBOX:CAD',
    name: 'Sandbox partner settlement',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    currencyCode: 'CAD',
    ownerType: 'PROVIDER',
    allowNegative: true,
  });
  const wallet = await ledger.ensureAccount({
    code: 'WALLET:org-a:CAD',
    name: 'Wallet org A',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    currencyCode: 'CAD',
    ownerType: 'ORGANIZATION',
  });
  const escrow = await ledger.ensureAccount({
    code: 'ESCROW:tx-1:CAD',
    name: 'Escrow tx-1',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    currencyCode: 'CAD',
    ownerType: 'TRANSACTION',
  });
  const fees = await ledger.ensureAccount({
    code: 'PLATFORM_FEES:CAD',
    name: 'Platform fees',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    currencyCode: 'CAD',
    ownerType: 'PLATFORM',
  });
  return { settlement, wallet, escrow, fees };
}

beforeEach(async () => {
  await resetLedgerTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('LedgerService', () => {
  it('posts a balanced transaction and derives balances', async () => {
    const { settlement, wallet } = await seedAccounts();
    const posted = await ledger.post({
      idempotencyKey: 'deposit-1',
      kind: 'DEPOSIT',
      description: 'Simulated deposit',
      entries: [
        { accountId: settlement.id, direction: 'DEBIT', amountMinor: 10_000n, currencyCode: 'CAD' },
        { accountId: wallet.id, direction: 'CREDIT', amountMinor: 10_000n, currencyCode: 'CAD' },
      ],
    });
    expect(posted.replayed).toBe(false);
    expect(posted.entries).toHaveLength(2);
    const walletBalance = await ledger.getBalance(wallet.id);
    expect(walletBalance.balanceMinor).toBe(10_000n);
    const settlementBalance = await ledger.getBalance(settlement.id);
    expect(settlementBalance.balanceMinor).toBe(10_000n);
  });

  it('rejects unbalanced postings before touching the database', async () => {
    const { settlement, wallet } = await seedAccounts();
    await expect(
      ledger.post({
        idempotencyKey: 'bad-1',
        kind: 'DEPOSIT',
        description: 'unbalanced',
        entries: [
          { accountId: settlement.id, direction: 'DEBIT', amountMinor: 10_000n, currencyCode: 'CAD' },
          { accountId: wallet.id, direction: 'CREDIT', amountMinor: 9_999n, currencyCode: 'CAD' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'LEDGER_UNBALANCED' });
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it('rejects zero or negative amounts and mixed currencies', async () => {
    const { settlement, wallet } = await seedAccounts();
    await expect(
      ledger.post({
        idempotencyKey: 'bad-2',
        kind: 'DEPOSIT',
        description: 'zero',
        entries: [
          { accountId: settlement.id, direction: 'DEBIT', amountMinor: 0n, currencyCode: 'CAD' },
          { accountId: wallet.id, direction: 'CREDIT', amountMinor: 0n, currencyCode: 'CAD' },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      ledger.post({
        idempotencyKey: 'bad-3',
        kind: 'DEPOSIT',
        description: 'mixed',
        entries: [
          { accountId: settlement.id, direction: 'DEBIT', amountMinor: 10n, currencyCode: 'CAD' },
          { accountId: wallet.id, direction: 'CREDIT', amountMinor: 10n, currencyCode: 'XOF' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('is idempotent: the same key never posts twice', async () => {
    const { settlement, wallet } = await seedAccounts();
    const instruction = {
      idempotencyKey: 'deposit-idem',
      kind: 'DEPOSIT' as const,
      description: 'Simulated deposit',
      entries: [
        { accountId: settlement.id, direction: 'DEBIT' as const, amountMinor: 500n, currencyCode: 'CAD' },
        { accountId: wallet.id, direction: 'CREDIT' as const, amountMinor: 500n, currencyCode: 'CAD' },
      ],
    };
    const first = await ledger.post(instruction);
    const second = await ledger.post(instruction);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await db.ledgerTransaction.count()).toBe(1);
    expect((await ledger.getBalance(wallet.id)).balanceMinor).toBe(500n);
  });

  it('serialises concurrent replays of one idempotency key into a single posting', async () => {
    const { settlement, wallet } = await seedAccounts();
    const instruction = {
      idempotencyKey: 'deposit-race',
      kind: 'DEPOSIT' as const,
      description: 'race',
      entries: [
        { accountId: settlement.id, direction: 'DEBIT' as const, amountMinor: 100n, currencyCode: 'CAD' },
        { accountId: wallet.id, direction: 'CREDIT' as const, amountMinor: 100n, currencyCode: 'CAD' },
      ],
    };
    const results = await Promise.all(Array.from({ length: 15 }, () => ledger.post(instruction)));
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await db.ledgerTransaction.count()).toBe(1);
    expect((await ledger.getBalance(wallet.id)).balanceMinor).toBe(100n);
  });

  it('never lets a protected account go negative under concurrent debits', async () => {
    const { settlement, wallet, escrow } = await seedAccounts();
    await ledger.post({
      idempotencyKey: 'fund-wallet',
      kind: 'DEPOSIT',
      description: 'fund',
      entries: [
        { accountId: settlement.id, direction: 'DEBIT', amountMinor: 1_000n, currencyCode: 'CAD' },
        { accountId: wallet.id, direction: 'CREDIT', amountMinor: 1_000n, currencyCode: 'CAD' },
      ],
    });
    // 25 concurrent attempts to move 100 each out of a wallet holding 1 000 → exactly 10 succeed.
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        ledger.post({
          idempotencyKey: `escrow-${i}`,
          kind: 'FUNDING',
          description: 'move to escrow',
          entries: [
            { accountId: wallet.id, direction: 'DEBIT', amountMinor: 100n, currencyCode: 'CAD' },
            { accountId: escrow.id, direction: 'CREDIT', amountMinor: 100n, currencyCode: 'CAD' },
          ],
        }),
      ),
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled').length;
    const failed = attempts.filter(
      (a) => a.status === 'rejected' && (a.reason as LedgerError).code === 'INSUFFICIENT_FUNDS',
    ).length;
    expect(ok).toBe(10);
    expect(failed).toBe(15);
    expect((await ledger.getBalance(wallet.id)).balanceMinor).toBe(0n);
    expect((await ledger.getBalance(escrow.id)).balanceMinor).toBe(1_000n);
  });

  it('rolls back everything when a posting fails inside an outer transaction', async () => {
    const { settlement, wallet } = await seedAccounts();
    await expect(
      db.$transaction(async (tx) => {
        await ledger.post(
          {
            idempotencyKey: 'outer-ok',
            kind: 'DEPOSIT',
            description: 'ok',
            entries: [
              { accountId: settlement.id, direction: 'DEBIT', amountMinor: 50n, currencyCode: 'CAD' },
              { accountId: wallet.id, direction: 'CREDIT', amountMinor: 50n, currencyCode: 'CAD' },
            ],
          },
          tx,
        );
        // Second step fails: wallet would go negative
        await ledger.post(
          {
            idempotencyKey: 'outer-fail',
            kind: 'WITHDRAWAL',
            description: 'too much',
            entries: [
              { accountId: wallet.id, direction: 'DEBIT', amountMinor: 999n, currencyCode: 'CAD' },
              { accountId: settlement.id, direction: 'CREDIT', amountMinor: 999n, currencyCode: 'CAD' },
            ],
          },
          tx,
        );
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await db.ledgerTransaction.count()).toBe(0);
    expect((await ledger.getBalance(wallet.id)).balanceMinor).toBe(0n);
  });

  it('reverses with a contra posting instead of deleting', async () => {
    const { settlement, wallet } = await seedAccounts();
    const posted = await ledger.post({
      idempotencyKey: 'to-reverse',
      kind: 'DEPOSIT',
      description: 'deposit',
      entries: [
        { accountId: settlement.id, direction: 'DEBIT', amountMinor: 300n, currencyCode: 'CAD' },
        { accountId: wallet.id, direction: 'CREDIT', amountMinor: 300n, currencyCode: 'CAD' },
      ],
    });
    const reversal = await ledger.reverse(posted.id, 'reverse-1', 'operator error');
    expect(reversal.kind).toBe('REVERSAL');
    expect((await ledger.getBalance(wallet.id)).balanceMinor).toBe(0n);
    expect(await db.ledgerTransaction.count()).toBe(2);
    const original = await db.ledgerTransaction.findUnique({ where: { id: posted.id } });
    expect(original?.status).toBe('REVERSED');
    await expect(ledger.reverse(posted.id, 'reverse-2', 'again')).rejects.toMatchObject({
      code: 'ALREADY_REVERSED',
    });
  });

  it('reconciles cleanly and detects a broken snapshot continuity', async () => {
    const { settlement, wallet, escrow, fees } = await seedAccounts();
    await ledger.post({
      idempotencyKey: 'r-1',
      kind: 'FUNDING',
      description: 'fund escrow',
      entries: [
        { accountId: settlement.id, direction: 'DEBIT', amountMinor: 10_000n, currencyCode: 'CAD' },
        { accountId: escrow.id, direction: 'CREDIT', amountMinor: 10_000n, currencyCode: 'CAD' },
      ],
    });
    await ledger.post({
      idempotencyKey: 'r-2',
      kind: 'RELEASE',
      description: 'release with fee',
      entries: [
        { accountId: escrow.id, direction: 'DEBIT', amountMinor: 10_000n, currencyCode: 'CAD' },
        { accountId: wallet.id, direction: 'CREDIT', amountMinor: 9_850n, currencyCode: 'CAD' },
        { accountId: fees.id, direction: 'CREDIT', amountMinor: 150n, currencyCode: 'CAD' },
      ],
    });
    await ledger.snapshot(wallet.id);
    const clean = await ledger.reconcile();
    expect(clean.differences).toHaveLength(0);
    expect(clean.unbalancedTransactions).toHaveLength(0);
    expect(clean.globalDebitsMinor.CAD).toBe(clean.globalCreditsMinor.CAD);

    // Tamper with the snapshot to simulate drift
    await db.balanceSnapshot.updateMany({ where: { accountId: wallet.id }, data: { balanceMinor: 1n } });
    const dirty = await ledger.reconcile();
    expect(dirty.differences.length).toBe(1);
    expect(dirty.differences[0].accountId).toBe(wallet.id);
  });
});
