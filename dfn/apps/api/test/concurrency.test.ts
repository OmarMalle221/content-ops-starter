import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService, walletAccountCode } from '@dfn/financial-ledger';
import { LEDGER } from '../src/modules/ledger/ledger.provider';
import { WalletsService } from '../src/modules/ledger/wallets.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { bootTestApp, registerUser, resetDatabase, type TestContext } from './helpers/app';
import { VEHICLE_TX, createActors, fundTransaction, uploadEvidence } from './helpers/protect';
import { balanceOf, createTransferActors, fundWallet, quoteAndCreate } from './helpers/transfers';
import { BANK_BENEFICIARY, createWalletActors, selfDeposit } from './helpers/wallet';

/**
 * Phase 6 — concurrency guarantees under parallel requests (sandbox, fictitious money).
 *
 * Every scenario fires its requests at once through the real HTTP stack (guards, pipes, services,
 * PostgreSQL row locks) and then checks the invariant from the database and the ledger, never from
 * the responses alone. The file shares one database so the final reconciliation covers every
 * posting written by the scenarios.
 *
 * Lazily created accounts (an organisation's first wallet in a currency, the platform's first
 * FX_CLEARING account of a currency) are warmed up before the money scenarios so that each money
 * scenario measures exactly the invariant it is about; concurrent first creation is covered on its
 * own (see "first use of a wallet").
 */
let ctx: TestContext;
let ledger: LedgerService;

beforeAll(async () => {
  ctx = await bootTestApp();
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
  ledger = ctx.app.get<LedgerService>(LEDGER);
});
afterAll(async () => {
  await ctx.close();
});

type Res = { status: number; body: any };
const succeeded = (results: Res[]) => results.filter((r) => r.status < 300);
const failed = (results: Res[]) => results.filter((r) => r.status >= 300);

describe('Concurrency — wallet, transfers, invoices, Protect releases', () => {
  it('20 parallel self-deposits around the daily cap never exceed it', async () => {
    const a = await createWalletActors(ctx, '-conc');
    // Default cap: 50 000.00 per organisation, currency and UTC day. The wallet already exists and
    // holds 1 000.00, so 16 × 3 000.00 fit (49 000.00) and a 17th would exceed the cap.
    const first = await selfDeposit(a.owner, a.businessOrgId, 'CAD', '1000.00');
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => selfDeposit(a.owner, a.businessOrgId, 'CAD', '3000.00')),
    );
    expect(succeeded(results)).toHaveLength(16);
    for (const r of failed(results)) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe('SANDBOX_LIMIT_REACHED');
    }

    expect(await balanceOf(ctx, walletAccountCode(a.businessOrgId, 'CAD'))).toBe(4_900_000n);
    const summary = await a.owner.get(`/v1/wallets/${a.businessOrgId}/summary`);
    const cad = summary.body.currencies.find((c: any) => c.currencyCode === 'CAD');
    expect(cad.selfDeposit.usedToday.decimal).toBe('49000.00');
    expect(cad.selfDeposit.remaining.decimal).toBe('1000.00');
    expect(BigInt(cad.selfDeposit.usedToday.minor)).toBeLessThanOrEqual(BigInt(cad.selfDeposit.limit.minor));
  });

  it('10 parallel authorisations draining one wallet: exactly the affordable ones succeed, never negative', async () => {
    const a = await createTransferActors(ctx, '-conc');
    // Warm-up: the platform already settled a CAD transfer (another tenant), so FX_CLEARING:CAD exists.
    const warmBeneficiary = await a.outsider.post('/v1/beneficiaries', {
      ...BANK_BENEFICIARY,
      organizationId: a.outsiderOrgId,
    });
    expect(warmBeneficiary.status, JSON.stringify(warmBeneficiary.body)).toBe(201);
    await fundWallet(ctx, a.outsiderOrgId, 'CAD', '100.00');
    const warm = await quoteAndCreate(a.outsider, warmBeneficiary.body.id, { amount: '10.00' });
    const warmAuth = await a.outsider.post(`/v1/transfers/${warm.transfer.id}/authorize`, {});
    expect(warmAuth.status, JSON.stringify(warmAuth.body)).toBe(200);
    expect(warmAuth.body.status).toBe('PROCESSING');

    const beneficiary = await a.owner.post('/v1/beneficiaries', {
      ...BANK_BENEFICIARY,
      organizationId: a.orgId,
    });
    expect(beneficiary.status, JSON.stringify(beneficiary.body)).toBe(201);
    // 1 000.00 CAD; each transfer debits 200.00 + fee (2.99 + 0.75 % = 4.49) = 204.49 → 4 fit.
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const transfers: Array<{ id: string }> = [];
    for (let i = 0; i < 10; i++) {
      const { transfer } = await quoteAndCreate(a.owner, beneficiary.body.id, { amount: '200.00' });
      expect(transfer.totalDebit.decimal).toBe('204.49');
      transfers.push(transfer);
    }
    // Ten transfers created by one organisation within 24 h legitimately trip TRANSFER_VELOCITY
    // (HIGH → manual review). Age the rows so that this scenario isolates the ledger race; the
    // velocity rule has its own tests.
    await ctx.prisma.transfer.updateMany({
      where: { id: { in: transfers.map((t) => t.id) } },
      data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
    });

    const results = await Promise.all(
      transfers.map((t) => a.owner.post(`/v1/transfers/${t.id}/authorize`, {})),
    );
    const accepted = succeeded(results);
    expect(accepted).toHaveLength(4);
    for (const r of accepted) expect(r.body.status).toBe('PROCESSING');
    for (const r of failed(results)) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe('INSUFFICIENT_FUNDS');
    }

    const balance = await balanceOf(ctx, walletAccountCode(a.orgId, 'CAD'));
    expect(balance).toBe(100_000n - 4n * 20_449n);
    expect(balance).toBeGreaterThanOrEqual(0n);
    const rows = await ctx.prisma.transfer.findMany({ where: { id: { in: transfers.map((t) => t.id) } } });
    expect(rows.filter((t) => t.status === 'PROCESSING')).toHaveLength(4);
    expect(rows.filter((t) => t.status === 'QUOTED')).toHaveLength(6);
    expect(rows.filter((t) => t.sourceLedgerTransactionId !== null)).toHaveLength(4);
    const sourceLegs = await ctx.prisma.ledgerTransaction.count({
      where: { idempotencyKey: { in: transfers.map((t) => `transfer-source:${t.id}`) } },
    });
    expect(sourceLegs).toBe(4);
  });

  it('10 parallel wallet payments on one invoice never over-pay it', async () => {
    const issuer = await createWalletActors(ctx, '-conc-inv');
    const { client: customer, user: customerUser } = await registerUser(ctx, 'conc-customer@example.com', {
      firstName: 'Mariama',
      lastName: 'Ba',
    });
    const customerOrgId = customerUser.organizations[0].id as string;
    await fundWallet(ctx, customerOrgId, 'CAD', '500.00');
    // Warm-up: the issuer already holds a CAD wallet (lazily created otherwise, see the first-use test).
    await ctx.app.get(WalletsService).ensureWallet(issuer.businessOrgId, 'CAD');

    const cp = await issuer.owner.post(`/v1/organizations/${issuer.businessOrgId}/counterparties`, {
      name: 'Mariama Ba',
      email: 'conc-customer-external@example.com',
      country: 'CA',
    });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    // Link accepted by the customer organisation (outcome of the consent workflow), set directly:
    // the link workflow has its own tests.
    await ctx.prisma.counterparty.update({
      where: { id: cp.body.id },
      data: {
        linkedOrganizationId: customerOrgId,
        linkStatus: 'ACCEPTED',
        linkRequestedOrganizationId: customerOrgId,
        linkRequestedAt: new Date(),
        linkDecidedAt: new Date(),
        linkDecidedByUserId: customerUser.id,
      },
    });
    const invoice = await issuer.owner.post('/v1/invoices', {
      organizationId: issuer.businessOrgId,
      counterpartyId: cp.body.id,
      customerName: 'Mariama Ba',
      customerEmail: 'conc-customer@example.com',
      currencyCode: 'CAD',
      dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      taxBps: 0,
      lines: [{ description: 'Service', quantity: 1, unitPrice: '100.00' }],
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    expect((await issuer.owner.post(`/v1/invoices/${invoice.body.id}/send`)).status).toBe(200);

    // 10 × 30.00 on a 100.00 invoice: exactly 3 payments fit (90.00).
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        customer.post(`/v1/invoices/${invoice.body.id}/payments`, {
          amount: '30.00',
          method: 'WALLET_SIMULATED',
          organizationId: customerOrgId,
        }),
      ),
    );
    expect(succeeded(results)).toHaveLength(3);
    for (const r of failed(results)) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }

    const row = await ctx.prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.body.id },
      include: { payments: true },
    });
    expect(row.paidMinor).toBe(9_000n);
    expect(row.paidMinor).toBeLessThanOrEqual(row.totalMinor);
    expect(row.status).toBe('PARTIALLY_PAID');
    expect(row.payments).toHaveLength(3);
    expect(row.payments.every((p) => p.ledgerTransactionId !== null)).toBe(true);
    // Money moved exactly once per accepted payment, from the customer to the issuer.
    expect(await balanceOf(ctx, walletAccountCode(customerOrgId, 'CAD'))).toBe(50_000n - 9_000n);
    expect(await balanceOf(ctx, walletAccountCode(issuer.businessOrgId, 'CAD'))).toBe(9_000n);
    const paymentPostings = await ctx.prisma.ledgerTransaction.count({
      where: { reference: invoice.body.id, kind: 'ADJUSTMENT' },
    });
    expect(paymentPostings).toBe(3);
  });

  it('10 parallel approvals of one milestone release it exactly once', async () => {
    const actors = await createActors(ctx, '-conc');
    const { txId, tx } = await fundTransaction(ctx, actors, {
      ...VEHICLE_TX,
      seller: { email: 'seller-conc@example.com', name: 'Dakar Auto Import' },
    });
    const milestone = tx.milestones[0];
    const bol = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING', 'bol.pdf');
    const submitted = await actors.seller.post(`/v1/transactions/${txId}/milestones/${milestone.id}/submit`, {
      documentIds: [bol],
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        actors.buyer.post(`/v1/transactions/${txId}/milestones/${milestone.id}/approve`, { note: 'OK' }),
      ),
    );
    expect(succeeded(results)).toHaveLength(1);
    for (const r of failed(results)) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
    }

    const releases = await ctx.prisma.ledgerTransaction.findMany({
      where: { kind: 'RELEASE', reference: txId },
      include: { entries: true },
    });
    expect(releases).toHaveLength(1);
    expect(releases[0].entries.find((e) => e.direction === 'CREDIT')?.amountMinor).toBe(925_000n);
    const row = await ctx.prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(row.status).toBe('RELEASED');
    expect(row.ledgerTransactionId).toBe(releases[0].id);
    const sellerOrgId = actors.sellerUser.organizations[0].id as string;
    expect(await balanceOf(ctx, walletAccountCode(sellerOrgId, 'CAD'))).toBe(925_000n);
  });

  it('first use of a wallet under 10 parallel deposits never corrupts the ledger', async () => {
    // The very first concurrent operations on a wallet that does not exist yet all succeed: the
    // wallet and its ledger account are created with INSERT … ON CONFLICT DO NOTHING, so a parallel
    // creation never surfaces as a 409 nor aborts the request's transaction.
    const { client, user } = await registerUser(ctx, 'conc-first-use@example.com');
    const orgId = user.organizations[0].id as string;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => selfDeposit(client, orgId, 'EUR', '10.00')),
    );
    const ok = succeeded(results);
    expect(
      failed(results).map((r) => r.body),
      'no request may fail on the first use of a wallet',
    ).toEqual([]);
    expect(ok).toHaveLength(10);
    expect(await ctx.prisma.wallet.count({ where: { organizationId: orgId, currencyCode: 'EUR' } })).toBe(1);
    expect(await balanceOf(ctx, walletAccountCode(orgId, 'EUR'))).toBe(BigInt(ok.length) * 1_000n);
    const deposits = await ctx.prisma.ledgerTransaction.count({
      where: { kind: 'DEPOSIT', reference: orgId },
    });
    expect(deposits).toBe(ok.length);
  });

  it('leaves a ledger that reconciles: no difference, no unbalanced transaction', async () => {
    const result = await ledger.reconcile();
    expect(result.accountsChecked).toBeGreaterThan(0);
    expect(result.differences).toEqual([]);
    expect(result.unbalancedTransactions).toEqual([]);
    for (const ccy of Object.keys(result.globalDebitsMinor)) {
      expect(result.globalDebitsMinor[ccy]).toBe(result.globalCreditsMinor[ccy]);
    }
    // No wallet anywhere went negative.
    for (const w of await ctx.prisma.wallet.findMany()) {
      expect((await ledger.getBalance(w.ledgerAccountId)).balanceMinor).toBeGreaterThanOrEqual(0n);
    }
  });
});
