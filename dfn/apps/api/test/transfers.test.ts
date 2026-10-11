import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { fxClearingCode, platformFeesCode, providerSettlementCode } from '@dfn/financial-ledger';
import { SANDBOX_PROVIDER_CODE } from '@dfn/payment-adapters';
import { DomainEventsBus, type DomainEvent } from '../src/common/events/domain-events';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { nominalLimitToMinor } from '../src/modules/transfers/transfers.service';
import { rateDisplay, transferNextActions } from '../src/modules/transfers/transfer.dto';
import { bootTestApp, resetDatabase, type TestContext } from './helpers/app';
import {
  balanceOf,
  createBeneficiary,
  createTransfer,
  createTransferActors,
  fundWallet,
  quoteAndCreate,
  requestQuote,
  sleep,
  walletBalance,
} from './helpers/transfers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

// 500.00 CAD → XOF with the sandbox rate (440 × 0.985) and fee schedule (2.99 + 0.75 %).
const SOURCE_MINOR = 50_000n;
const FEE_MINOR = 674n; // 299 + round-half-up(50000 × 75 / 10000) = 299 + 375
const DESTINATION_MINOR = 216_700n;

describe('pure helpers', () => {
  it('formats the rate on major units with integer arithmetic', () => {
    expect(rateDisplay(440n * 9850n, 10_000n, 'CAD', 'XOF')).toBe('1 CAD = 433.40 XOF');
    expect(rateDisplay(73n * 9850n, 100n * 10_000n, 'CAD', 'USD')).toBe('1 CAD = 0.71905 USD');
    expect(rateDisplay(1n, 1n, 'EUR', 'EUR')).toBe('1 EUR = 1.00 EUR');
  });

  it('scales a nominal daily limit to the currency exponent', () => {
    expect(nominalLimitToMinor('2500.00', 'CAD')).toBe(250_000n);
    expect(nominalLimitToMinor('2500.00', 'XOF')).toBe(2500n);
    expect(nominalLimitToMinor('10', 'EUR')).toBe(1000n);
  });

  it('derives next actions from status and role', () => {
    const base = { status: 'QUOTED' } as any;
    expect(transferNextActions(base, { isStaff: false, role: 'OWNER' })).toEqual(['AUTHORIZE', 'CANCEL']);
    expect(transferNextActions(base, { isStaff: false, role: 'MEMBER' })).toEqual(['CANCEL']);
    expect(transferNextActions(base, { isStaff: false, role: 'VIEWER' })).toEqual([]);
    expect(transferNextActions({ status: 'REVIEW_REQUIRED' } as any, { isStaff: true, role: null })).toEqual([
      'REVIEW',
    ]);
    expect(transferNextActions({ status: 'PROCESSING' } as any, { isStaff: false, role: 'OWNER' })).toEqual([
      'SIMULATE_PARTNER_SETTLEMENT',
      'SIMULATE_PARTNER_FAILURE',
    ]);
    expect(transferNextActions({ status: 'SETTLED' } as any, { isStaff: false, role: 'VIEWER' })).toEqual([
      'VIEW_RECEIPT',
    ]);
    expect(transferNextActions({ status: 'CANCELLED' } as any, { isStaff: false, role: 'OWNER' })).toEqual(
      [],
    );
  });
});

describe('FX quotes', () => {
  it('creates a simulated quote with frozen rate, fee and expiry', async () => {
    const a = await createTransferActors(ctx);
    const quote = await requestQuote(a.owner);
    expect(quote.organizationId).toBe(a.orgId);
    expect(quote.status).toBe('QUOTED');
    expect(quote.simulated).toBe(true);
    expect(quote.disclaimer).toBe('Données fictives — Aucun fonds réel');
    expect(quote.source).toEqual({ minor: '50000', decimal: '500.00', currency: 'CAD' });
    expect(quote.fee.minor).toBe(FEE_MINOR.toString());
    expect(quote.fee.feeBps).toBe(75);
    expect(quote.fee.fixedFee.decimal).toBe('2.99');
    expect(quote.totalDebit.minor).toBe((SOURCE_MINOR + FEE_MINOR).toString());
    expect(quote.destination).toEqual({ minor: '216700', decimal: '216700', currency: 'XOF' });
    expect(quote.rate.display).toBe('1 CAD = 433.40 XOF');
    expect(quote.spreadBps).toBe(150);
    expect(quote.provider).toBe('sandbox');
    expect(new Date(quote.expiresAt).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

    const fetched = await a.owner.get(`/v1/transfers/quotes/${quote.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.rate.display).toBe('1 CAD = 433.40 XOF');
    expect(fetched.body.spreadBps).toBe(150);

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'fx_quote.created', entityId: quote.id },
    });
    expect(audit?.organizationId).toBe(a.orgId);
  });

  it('rejects an unsupported corridor (400) and invalid payloads', async () => {
    const a = await createTransferActors(ctx);
    const unsupported = await a.owner.post('/v1/transfers/quotes', {
      originCountry: 'FR',
      destinationCountry: 'GN',
      sourceCurrency: 'EUR',
      destinationCurrency: 'GNF',
      amount: '100.00',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('CORRIDOR_UNSUPPORTED');

    const sameCountry = await a.owner.post('/v1/transfers/quotes', {
      originCountry: 'CA',
      destinationCountry: 'CA',
      sourceCurrency: 'CAD',
      destinationCurrency: 'CAD',
      amount: '100.00',
    });
    expect(sameCountry.status).toBe(400);
    expect(sameCountry.body.code).toBe('VALIDATION_FAILED');

    const badAmount = await a.owner.post('/v1/transfers/quotes', {
      ...{ originCountry: 'CA', destinationCountry: 'SN', sourceCurrency: 'CAD', destinationCurrency: 'XOF' },
      amount: '12.345',
    });
    expect(badAmount.status).toBe(400);
  });

  it('is invisible to other tenants (404) and forbidden to the wrong role (403)', async () => {
    const a = await createTransferActors(ctx);
    const quote = await requestQuote(a.owner);
    const cross = await a.outsider.get(`/v1/transfers/quotes/${quote.id}`);
    expect(cross.status).toBe(404);
    // Quoting for an organisation the caller is not a member of: 404, never 403.
    const forOther = await a.outsider.post('/v1/transfers/quotes', {
      ...{
        originCountry: 'CA',
        destinationCountry: 'SN',
        sourceCurrency: 'CAD',
        destinationCurrency: 'XOF',
        amount: '10.00',
      },
      organizationId: a.orgId,
    });
    expect(forOther.status).toBe(404);
    // Staff may read any quote.
    const staff = await a.compliance.get(`/v1/transfers/quotes/${quote.id}`);
    expect(staff.status).toBe(200);
  });
});

describe('transfer lifecycle', () => {
  it('quote → create → authorize → partner settlement, with exact ledger postings', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const events: DomainEvent[] = [];
    const unsubscribe = ctx.app.get(DomainEventsBus).on((e) => {
      if (e.type.startsWith('transfer.')) events.push(e);
    });
    try {
      const quote = await requestQuote(a.owner);
      const created = await createTransfer(a.owner, quote.id, beneficiary.id, { reference: 'Loyer octobre' });
      expect(created.status).toBe('QUOTED');
      expect(created.reference).toMatch(/^DFT-\d{4}-[A-Z0-9]{6}$/);
      expect(created.organizationId).toBe(a.orgId);
      expect(created.simulated).toBe(true);
      expect(created.source.minor).toBe('50000');
      expect(created.fee.minor).toBe(FEE_MINOR.toString());
      expect(created.totalDebit.minor).toBe((SOURCE_MINOR + FEE_MINOR).toString());
      expect(created.destination.minor).toBe(DESTINATION_MINOR.toString());
      expect(created.rate.display).toBe('1 CAD = 433.40 XOF');
      expect(created.beneficiary).toMatchObject({
        name: 'Awa Diop',
        country: 'SN',
        currencyCode: 'XOF',
        accountIdentifierMasked: '••••7890',
      });
      expect(JSON.stringify(created)).not.toContain('0152');
      expect(created.clientReference).toBe('Loyer octobre');
      expect(created.events.map((e: any) => e.type)).toEqual(['transfer.created', 'transfer.quoted']);
      expect(created.nextActions).toEqual(['AUTHORIZE', 'CANCEL']);
      expect(created.myRole).toBe('OWNER');
      const usedQuote = await ctx.prisma.fXQuote.findUniqueOrThrow({ where: { id: quote.id } });
      expect(usedQuote.status).toBe('USED');
      // The same quote cannot back a second transfer.
      const again = await a.owner.post('/v1/transfers', { quoteId: quote.id, beneficiaryId: beneficiary.id });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('QUOTE_USED');
      // No money moved yet.
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n);

      const authorized = await a.owner.post(`/v1/transfers/${created.id}/authorize`, {});
      expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
      expect(authorized.body.status).toBe('PROCESSING');
      expect(authorized.body.authorizedAt).toBeTruthy();
      expect(authorized.body.processingAt).toBeTruthy();
      expect(authorized.body.provider).toBe(SANDBOX_PROVIDER_CODE);
      expect(authorized.body.ledger.sourceLedgerTransactionId).toBeTruthy();
      expect(authorized.body.nextActions).toEqual([
        'SIMULATE_PARTNER_SETTLEMENT',
        'SIMULATE_PARTNER_FAILURE',
      ]);
      expect(authorized.body.events.map((e: any) => e.type)).toEqual([
        'transfer.created',
        'transfer.quoted',
        'transfer.authorized',
        'transfer.processing',
      ]);
      // Source leg: wallet −(amount+fee), FX clearing +amount, platform fees +fee.
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n - SOURCE_MINOR - FEE_MINOR);
      expect(await balanceOf(ctx, fxClearingCode('CAD'))).toBe(SOURCE_MINOR);
      expect(await balanceOf(ctx, platformFeesCode('CAD'))).toBe(FEE_MINOR);
      const sourceTx = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
        where: { idempotencyKey: `transfer-source:${created.id}` },
        include: { entries: true },
      });
      expect(sourceTx.kind).toBe('WITHDRAWAL');
      expect(sourceTx.entries).toHaveLength(3);
      const accepted = await ctx.prisma.providerEvent.findUnique({
        where: { idempotencyKey: `${SANDBOX_PROVIDER_CODE}:${created.reference}:ACCEPTED` },
      });
      expect(accepted?.type).toBe('transfer.accepted');
      expect(accepted?.status).toBe('PROCESSED');
      const processingNotif = await ctx.prisma.notification.findFirst({
        where: { userId: a.ownerUser.id, type: 'transfer.processing' },
      });
      expect(processingNotif?.title).toContain('Transfert en traitement (simulé)');
      expect(processingNotif?.body).toContain('Données fictives — Aucun fonds réel');
      const authorizedAudit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'transfer.authorized', entityId: created.id },
      });
      expect(authorizedAudit?.actorUserId).toBe(a.ownerUser.id);
      // Nothing to receive before the partner answers.
      const receiptPending = await a.owner.get(`/v1/transfers/${created.id}/receipt`);
      expect(receiptPending.status).toBe(200);
      expect(receiptPending.body.status).toBe('PROCESSING');

      const settled = await a.owner.post('/v1/sandbox/partner/transfer-events', {
        transferReference: created.reference,
        outcome: 'SETTLED',
        externalRef: 'sbx_partner_42',
      });
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect(settled.body.replayed).toBe(false);
      expect(settled.body.status).toBe('PROCESSED');
      expect(settled.body.transfer.status).toBe('SETTLED');
      expect(settled.body.transfer.externalRef).toBe('sbx_partner_42');
      expect(settled.body.transfer.nextActions).toEqual(['VIEW_RECEIPT']);
      // Destination leg: FX clearing (XOF) −destination, partner settlement −destination (paid out).
      expect(await balanceOf(ctx, fxClearingCode('XOF'))).toBe(-DESTINATION_MINOR);
      expect(await balanceOf(ctx, providerSettlementCode(SANDBOX_PROVIDER_CODE, 'XOF'))).toBe(
        -DESTINATION_MINOR,
      );
      expect(await balanceOf(ctx, fxClearingCode('CAD'))).toBe(SOURCE_MINOR);
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n - SOURCE_MINOR - FEE_MINOR);
      const destTx = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
        where: { idempotencyKey: `transfer-dest:${created.id}` },
      });
      expect(settled.body.transfer.ledger.destinationLedgerTransactionId).toBe(destTx.id);

      // Replaying the partner event is a no-op.
      const replay = await a.owner.post('/v1/sandbox/partner/transfer-events', {
        transferReference: created.reference,
        outcome: 'SETTLED',
      });
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: created.id } })).toBe(2);
      // A late failure after settlement is ignored (no reversal).
      const lateFailure = await a.owner.post('/v1/sandbox/partner/transfer-events', {
        transferReference: created.reference,
        outcome: 'FAILED',
      });
      expect(lateFailure.status).toBe(200);
      expect(lateFailure.body.status).toBe('IGNORED');
      expect(lateFailure.body.transfer.status).toBe('SETTLED');
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n - SOURCE_MINOR - FEE_MINOR);

      const detail = await a.owner.get(`/v1/transfers/${created.id}`);
      expect(detail.body.status).toBe('SETTLED');
      expect(detail.body.settledAt).toBeTruthy();
      expect(detail.body.events.map((e: any) => e.type)).toContain('transfer.settled');

      const receipt = await a.owner.get(`/v1/transfers/${created.id}/receipt`);
      expect(receipt.status).toBe(200);
      expect(receipt.body.simulated).toBe(true);
      expect(receipt.body.disclaimer).toBe('Données fictives — Aucun fonds réel');
      expect(receipt.body.reference).toBe(created.reference);
      expect(receipt.body.destination.decimal).toBe('216700');
      expect(receipt.body.beneficiary.accountIdentifierMasked).toBe('••••7890');
      const txt = await a.owner.get(`/v1/transfers/${created.id}/receipt?format=txt`);
      expect(txt.status).toBe(200);
      expect(txt.headers['content-type']).toContain('text/plain');
      expect(txt.text).toContain('SANDBOX');
      expect(txt.text).toContain('Données fictives — Aucun fonds réel');
      expect(txt.text).toContain(created.reference);

      const settledNotif = await ctx.prisma.notification.findFirst({
        where: { userId: a.ownerUser.id, type: 'transfer.settled' },
      });
      expect(settledNotif?.title).toContain('Transfert réglé (simulé)');
      const list = await a.owner.get('/v1/transfers?status=SETTLED');
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].reference).toBe(created.reference);
      expect(list.body.items[0].beneficiaryName).toBe('Awa Diop');
      expect(list.body.simulated).toBe(true);

      await sleep(30);
      const settledEvent = events.find((e) => e.type === 'transfer.settled');
      expect(settledEvent).toBeTruthy();
      expect(settledEvent?.organizationIds).toEqual([a.orgId]);
      expect(settledEvent?.entityType).toBe('Transfer');
      expect(settledEvent?.payload).toMatchObject({
        transferId: created.id,
        reference: created.reference,
        status: 'SETTLED',
        sourceAmount: '500.00',
        destinationAmount: '216700',
        sourceCurrency: 'CAD',
        destinationCurrency: 'XOF',
      });
    } finally {
      unsubscribe();
    }
  });

  it('refunds the wallet by reversal when the simulated partner fails', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const events: DomainEvent[] = [];
    const unsubscribe = ctx.app.get(DomainEventsBus).on((e) => {
      if (e.type.startsWith('transfer.')) events.push(e);
    });
    try {
      const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
      const authorized = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
      expect(authorized.status).toBe(200);
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n - SOURCE_MINOR - FEE_MINOR);

      const failed = await a.owner.post('/v1/sandbox/partner/transfer-events', {
        transferReference: transfer.reference,
        outcome: 'FAILED',
        failureReason: 'Beneficiary account closed (simulated)',
      });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
      expect(failed.body.transfer.status).toBe('FAILED');
      expect(failed.body.transfer.failureReason).toBe('Beneficiary account closed (simulated)');
      expect(failed.body.transfer.failedAt).toBeTruthy();
      expect(failed.body.transfer.ledger.reversalLedgerTransactionId).toBeTruthy();
      expect(failed.body.transfer.events.map((e: any) => e.type)).toContain('transfer.reversed');
      // Everything is back where it was; the original posting is marked REVERSED, never deleted.
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n);
      expect(await balanceOf(ctx, fxClearingCode('CAD'))).toBe(0n);
      expect(await balanceOf(ctx, platformFeesCode('CAD'))).toBe(0n);
      expect(await balanceOf(ctx, fxClearingCode('XOF'))).toBe(0n);
      const original = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
        where: { idempotencyKey: `transfer-source:${transfer.id}` },
      });
      expect(original.status).toBe('REVERSED');
      const reversal = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
        where: { idempotencyKey: `transfer-reversal:${transfer.id}` },
      });
      expect(reversal.kind).toBe('REVERSAL');
      expect(reversal.reversesId).toBe(original.id);
      expect(
        await ctx.prisma.ledgerTransaction.count({
          where: { idempotencyKey: `transfer-dest:${transfer.id}` },
        }),
      ).toBe(0);

      // Replay and late settlement are both harmless.
      const replay = await a.owner.post('/v1/sandbox/partner/transfer-events', {
        transferReference: transfer.reference,
        outcome: 'FAILED',
      });
      expect(replay.body.replayed).toBe(true);
      const late = await a.owner.post('/v1/sandbox/partner/transfer-events', {
        transferReference: transfer.reference,
        outcome: 'SETTLED',
      });
      expect(late.body.status).toBe('IGNORED');
      expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n);

      const notif = await ctx.prisma.notification.findFirst({
        where: { userId: a.ownerUser.id, type: 'transfer.failed' },
      });
      expect(notif?.title).toContain('fonds fictifs recrédités');
      const receipt = await a.owner.get(`/v1/transfers/${transfer.id}/receipt?format=txt`);
      expect(receipt.status).toBe(200);
      expect(receipt.text).toContain('Beneficiary account closed (simulated)');

      await sleep(30);
      const failedEvent = events.find((e) => e.type === 'transfer.failed');
      expect(failedEvent?.organizationIds).toEqual([a.orgId]);
      expect(failedEvent?.payload).toMatchObject({
        transferId: transfer.id,
        status: 'FAILED',
        sourceCurrency: 'CAD',
      });
    } finally {
      unsubscribe();
    }
  });

  it('refuses to authorise without sufficient fictitious funds (409) and leaves the transfer QUOTED', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '500.00'); // amount covered, fee is not
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    const res = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
    const row = await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(row.status).toBe('QUOTED');
    expect(row.sourceLedgerTransactionId).toBeNull();
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(50_000n);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: transfer.id } })).toBe(0);
    expect(
      await ctx.prisma.transferEvent.count({
        where: { transferId: transfer.id, type: 'transfer.authorized' },
      }),
    ).toBe(0);
    // No wallet at all for the currency: still a clean 409.
    const b = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
      country: 'GN',
      currencyCode: 'GNF',
    });
    const { transfer: t2 } = await quoteAndCreate(a.owner, b.id, {
      destinationCountry: 'GN',
      sourceCurrency: 'USD',
      destinationCurrency: 'GNF',
      originCountry: 'US',
      amount: '20.00',
    });
    const res2 = await a.owner.post(`/v1/transfers/${t2.id}/authorize`, {});
    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects expired quotes (409) and expires stale QUOTED transfers lazily', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const quote = await requestQuote(a.owner);
    await ctx.prisma.fXQuote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await a.owner.post('/v1/transfers', { quoteId: quote.id, beneficiaryId: beneficiary.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTE_EXPIRED');
    expect((await a.owner.get(`/v1/transfers/quotes/${quote.id}`)).body.status).toBe('EXPIRED');

    // A transfer created from a live quote expires once that quote's validity elapses.
    const { quote: q2, transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    await ctx.prisma.fXQuote.update({
      where: { id: q2.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const listed = await a.owner.get('/v1/transfers');
    expect(listed.body.items[0].status).toBe('EXPIRED');
    const detail = await a.owner.get(`/v1/transfers/${transfer.id}`);
    expect(detail.body.status).toBe('EXPIRED');
    expect(detail.body.events.map((e: any) => e.type)).toContain('transfer.expired');
    expect(detail.body.nextActions).toEqual([]);
    const authorize = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(authorize.status).toBe(409);
    expect(authorize.body.code).toBe('QUOTE_EXPIRED');
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n);
  });

  it('requires a valid TOTP code when the user has MFA enabled (401 MFA_REQUIRED)', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const setup = await a.owner.post('/v1/auth/mfa/setup');
    expect(setup.status).toBe(201);
    const secret = setup.body.secret as string;
    expect((await a.owner.post('/v1/auth/mfa/enable', { code: authenticator.generate(secret) })).status).toBe(
      201,
    );

    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    const missing = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('MFA_REQUIRED');
    const wrong = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, { mfaCode: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('MFA_REQUIRED');
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n);
    const ok = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {
      mfaCode: authenticator.generate(secret),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('PROCESSING');
    const authorizedEvent = await ctx.prisma.transferEvent.findFirst({
      where: { transferId: transfer.id, type: 'transfer.authorized' },
    });
    expect((authorizedEvent?.payload as any).mfaVerified).toBe(true);

    // The user may opt out of the second factor for transfers.
    await ctx.prisma.user.update({
      where: { id: a.ownerUser.id },
      data: {
        securityPreferences: {
          requireMfaForTransfers: false,
          transferAlerts: true,
          dailyTransferLimit: null,
        },
      },
    });
    const { transfer: t2 } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '50.00' });
    const noCode = await a.owner.post(`/v1/transfers/${t2.id}/authorize`, {});
    expect(noCode.status, JSON.stringify(noCode.body)).toBe(200);
    expect(noCode.body.status).toBe('PROCESSING');
  });

  it('enforces the self-imposed daily transfer limit (409 DAILY_LIMIT_EXCEEDED)', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '5000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    await ctx.prisma.user.update({
      where: { id: a.ownerUser.id },
      data: {
        securityPreferences: {
          requireMfaForTransfers: true,
          transferAlerts: true,
          dailyTransferLimit: '600.00',
        },
      },
    });
    const { transfer: first } = await quoteAndCreate(a.owner, beneficiary.id); // 500 CAD
    expect((await a.owner.post(`/v1/transfers/${first.id}/authorize`, {})).status).toBe(200);
    const { transfer: second } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '200.00' });
    const blocked = await a.owner.post(`/v1/transfers/${second.id}/authorize`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(blocked.body.details.limit.decimal).toBe('600.00');
    expect(blocked.body.details.usedToday.decimal).toBe('500.00');
    const { transfer: third } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '100.00' });
    expect((await a.owner.post(`/v1/transfers/${third.id}/authorize`, {})).status).toBe(200);
  });

  it('validates the beneficiary against the quote destination', async () => {
    const a = await createTransferActors(ctx);
    const quote = await requestQuote(a.owner);
    const wrongCurrency = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
      country: 'GN',
      currencyCode: 'GNF',
    });
    const mismatch = await a.owner.post('/v1/transfers', {
      quoteId: quote.id,
      beneficiaryId: wrongCurrency.id,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('BENEFICIARY_MISMATCH');
    const removed = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
      status: 'REMOVED',
    });
    const inactive = await a.owner.post('/v1/transfers', { quoteId: quote.id, beneficiaryId: removed.id });
    expect(inactive.status).toBe(400);
    expect(inactive.body.code).toBe('BENEFICIARY_INACTIVE');
    const foreign = await createBeneficiary(ctx, {
      organizationId: a.outsiderOrgId,
      createdByUserId: a.outsiderUser.id,
    });
    const crossTenant = await a.owner.post('/v1/transfers', { quoteId: quote.id, beneficiaryId: foreign.id });
    expect(crossTenant.status).toBe(404);
    // The quote is still usable after the rejected attempts.
    const stillQuoted = await ctx.prisma.fXQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(stillQuoted.status).toBe('QUOTED');
  });

  it('cancels QUOTED transfers and refuses to cancel once processing (409)', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    const cancelled = await a.owner.post(`/v1/transfers/${transfer.id}/cancel`, {
      reason: 'Mauvais bénéficiaire',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelReason).toBe('Mauvais bénéficiaire');
    expect(cancelled.body.nextActions).toEqual([]);
    const twice = await a.owner.post(`/v1/transfers/${transfer.id}/cancel`, { reason: 'encore' });
    expect(twice.status).toBe(409);
    const { transfer: t2 } = await quoteAndCreate(a.owner, beneficiary.id);
    expect((await a.owner.post(`/v1/transfers/${t2.id}/authorize`, {})).status).toBe(200);
    const processing = await a.owner.post(`/v1/transfers/${t2.id}/cancel`, { reason: 'trop tard' });
    expect(processing.status).toBe(409);
    expect(processing.body.code).toBe('INVALID_TRANSITION');
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n - SOURCE_MINOR - FEE_MINOR);
  });

  it('does not let a premature partner outcome block the real settlement', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    // SETTLED while still QUOTED: journaled as IGNORED, must not consume the canonical key.
    const premature = await a.owner.post('/v1/sandbox/partner/transfer-events', {
      transferReference: transfer.reference,
      outcome: 'SETTLED',
    });
    expect(premature.status, JSON.stringify(premature.body)).toBe(200);
    expect(premature.body.status).toBe('IGNORED');
    expect(premature.body.transfer.status).toBe('QUOTED');
    expect((await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {})).status).toBe(200);
    const settled = await a.owner.post('/v1/sandbox/partner/transfer-events', {
      transferReference: transfer.reference,
      outcome: 'SETTLED',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.replayed).toBe(false);
    expect(settled.body.status).toBe('PROCESSED');
    expect(settled.body.transfer.status).toBe('SETTLED');
    expect(await balanceOf(ctx, fxClearingCode('CAD'))).toBe(SOURCE_MINOR);
    expect(await balanceOf(ctx, fxClearingCode('XOF'))).toBe(-DESTINATION_MINOR);
  });
});

describe('compliance review', () => {
  it('holds a high-risk authorisation for review, then staff approve (→ PROCESSING) or reject (→ CANCELLED)', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '40000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    // 15 000 CAD by an unverified user: UNVERIFIED_TRANSFER (HIGH) → MANUAL_REVIEW.
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '15000.00' });
    const held = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.status).toBe('REVIEW_REQUIRED');
    expect(held.body.riskScore).toBeGreaterThanOrEqual(45);
    // Members only see a generic reason: rule codes and thresholds are reserved to staff.
    expect(held.body.reviewReason).toBe('COMPLIANCE_REVIEW');
    expect(held.body.reviewReason).not.toContain('UNVERIFIED_TRANSFER');
    const staffView = await a.compliance.get(`/v1/admin/transfers/${transfer.id}`);
    expect(staffView.status, JSON.stringify(staffView.body)).toBe(200);
    expect(staffView.body.reviewReason).toContain('UNVERIFIED_TRANSFER');
    expect(held.body.nextActions).toEqual(['CANCEL']);
    expect(held.body.ledger.sourceLedgerTransactionId).toBeNull();
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(4_000_000n);
    const alerts = await ctx.prisma.riskAlert.findMany({ where: { organizationId: a.orgId } });
    expect(alerts.map((x) => x.ruleCode)).toContain('UNVERIFIED_TRANSFER');
    const staffNotif = await ctx.prisma.notification.findFirst({
      where: { userId: a.complianceUser.id, type: 'transfer.review_required' },
    });
    expect(staffNotif?.title).toContain('Revue requise');
    const memberNotif = await ctx.prisma.notification.findFirst({
      where: { userId: a.ownerUser.id, type: 'transfer.review_required' },
    });
    expect(memberNotif?.body).toContain("Aucun fonds fictif n'a été débité");

    // Members cannot bypass the review.
    const again = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    // Non-staff cannot reach the back-office (403), staff see the queue.
    expect((await a.owner.get('/v1/admin/transfers')).status).toBe(403);
    expect(
      (await a.owner.post(`/v1/admin/transfers/${transfer.id}/review`, { decision: 'APPROVE', note: 'nope' }))
        .status,
    ).toBe(403);
    const queue = await a.compliance.get('/v1/admin/transfers?status=REVIEW_REQUIRED');
    expect(queue.status).toBe(200);
    expect(queue.body.reviewQueue).toBe(1);
    expect(queue.body.items[0].id).toBe(transfer.id);
    expect(queue.body.items[0].createdBy.email).toBe('xfer-owner@example.com');
    const staffDetail = await a.compliance.get(`/v1/transfers/${transfer.id}`);
    expect(staffDetail.status).toBe(200);
    expect(staffDetail.body.myRole).toBe('STAFF');
    expect(staffDetail.body.nextActions).toEqual(['REVIEW']);

    const approved = await a.compliance.post(`/v1/admin/transfers/${transfer.id}/review`, {
      decision: 'APPROVE',
      note: 'Documents justificatifs reçus hors ligne (sandbox).',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('PROCESSING');
    expect(approved.body.reviewedAt).toBeTruthy();
    expect(approved.body.reviewNote).toContain('Documents justificatifs');
    expect(approved.body.events.map((e: any) => e.type)).toEqual([
      'transfer.created',
      'transfer.quoted',
      'transfer.review_required',
      'transfer.review_approved',
      'transfer.authorized',
      'transfer.processing',
    ]);
    const feeMinor = 299n + 11_250n;
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(4_000_000n - 1_500_000n - feeMinor);
    expect(await balanceOf(ctx, fxClearingCode('CAD'))).toBe(1_500_000n);
    const row = await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(row.reviewedByUserId).toBe(a.complianceUser.id);
    const approvedAudit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'transfer.review_approved', entityId: transfer.id },
    });
    expect(approvedAudit?.actorUserId).toBe(a.complianceUser.id);
    const approvedNotif = await ctx.prisma.notification.findFirst({
      where: { userId: a.ownerUser.id, type: 'transfer.review_approved' },
    });
    expect(approvedNotif).toBeTruthy();
    // Reviewing twice is an invalid transition.
    const reReview = await a.compliance.post(`/v1/admin/transfers/${transfer.id}/review`, {
      decision: 'REJECT',
      note: 'changed my mind',
    });
    expect(reReview.status).toBe(409);
    // COMPLIANCE reviews but cannot drive the simulated partner (SANDBOX_PARTNER_SIMULATE is ADMIN
    // only); the organisation itself can still trigger the sandbox settlement of the approved transfer.
    const denied = await a.compliance.post('/v1/sandbox/partner/transfer-events', {
      transferReference: transfer.reference,
      outcome: 'SETTLED',
    });
    expect(denied.status).toBe(403);
    const settled = await a.owner.post('/v1/sandbox/partner/transfer-events', {
      transferReference: transfer.reference,
      outcome: 'SETTLED',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.transfer.status).toBe('SETTLED');

    // Rejection path.
    const { transfer: t2 } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '15000.00' });
    expect((await a.owner.post(`/v1/transfers/${t2.id}/authorize`, {})).body.status).toBe('REVIEW_REQUIRED');
    const balanceBefore = await walletBalance(ctx, a.orgId, 'CAD');
    const rejected = await a.compliance.post(`/v1/admin/transfers/${t2.id}/review`, {
      decision: 'REJECT',
      note: 'Origine des fonds non documentée.',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.status).toBe('CANCELLED');
    expect(rejected.body.reviewNote).toBe('Origine des fonds non documentée.');
    expect(rejected.body.events.map((e: any) => e.type)).toContain('transfer.review_rejected');
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(balanceBefore);
    const rejectedNotif = await ctx.prisma.notification.findFirst({
      where: { userId: a.ownerUser.id, type: 'transfer.review_rejected' },
    });
    expect(rejectedNotif?.body).toContain('Origine des fonds non documentée.');
    const all = await a.compliance.get('/v1/admin/transfers');
    expect(all.body.total).toBe(2);
    expect(all.body.reviewQueue).toBe(0);
  });

  it('lets the organisation cancel a transfer awaiting review (no ledger movement)', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '40000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '15000.00' });
    expect((await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {})).body.status).toBe(
      'REVIEW_REQUIRED',
    );
    const cancelled = await a.owner.post(`/v1/transfers/${transfer.id}/cancel`, { reason: 'Je renonce' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(4_000_000n);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: transfer.id } })).toBe(0);
  });
});

describe('authorization boundaries', () => {
  it('hides transfers from other tenants (404) and enforces organisation roles (403)', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '1000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);

    expect((await a.outsider.get(`/v1/transfers/${transfer.id}`)).status).toBe(404);
    expect((await a.outsider.post(`/v1/transfers/${transfer.id}/authorize`, {})).status).toBe(404);
    expect((await a.outsider.post(`/v1/transfers/${transfer.id}/cancel`, { reason: 'hijack' })).status).toBe(
      404,
    );
    expect((await a.outsider.get(`/v1/transfers/${transfer.id}/receipt`)).status).toBe(404);
    expect((await a.outsider.get(`/v1/transfers?organizationId=${a.orgId}`)).status).toBe(404);
    const outsiderList = await a.outsider.get('/v1/transfers');
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.total).toBe(0);
    const event = await a.outsider.post('/v1/sandbox/partner/transfer-events', {
      transferReference: transfer.reference,
      outcome: 'SETTLED',
    });
    expect(event.status).toBe(404);
    const unknownRef = await a.owner.post('/v1/sandbox/partner/transfer-events', {
      transferReference: 'DFT-2026-NOPE00',
      outcome: 'SETTLED',
    });
    expect(unknownRef.status).toBe(404);
    expect(await walletBalance(ctx, a.orgId, 'CAD')).toBe(100_000n);

    // A VIEWER of the organisation may read but neither create, authorise nor cancel.
    const org = await a.owner.post('/v1/organizations', {
      name: 'Teranga Export',
      country: 'CA',
      legalName: 'Teranga Export Inc.',
      registrationNumber: 'CA-QC-2024-0001',
    });
    expect(org.status).toBe(201);
    const invite = await a.owner.post(`/v1/organizations/${org.body.id}/members/invite`, {
      email: 'xfer-outsider@example.com',
      role: 'VIEWER',
    });
    expect(invite.status).toBe(201);
    expect(
      (await a.outsider.post('/v1/organizations/invitations/accept', { token: invite.body.token })).status,
    ).toBe(201);
    await fundWallet(ctx, org.body.id, 'CAD', '1000.00');
    const viewerQuote = await a.outsider.post('/v1/transfers/quotes', {
      originCountry: 'CA',
      destinationCountry: 'SN',
      sourceCurrency: 'CAD',
      destinationCurrency: 'XOF',
      amount: '10.00',
      organizationId: org.body.id,
    });
    expect(viewerQuote.status).toBe(403);
    const b2 = await createBeneficiary(ctx, { organizationId: org.body.id, createdByUserId: a.ownerUser.id });
    const { transfer: t2 } = await quoteAndCreate(a.owner, b2.id, { organizationId: org.body.id });
    const viewerRead = await a.outsider.get(`/v1/transfers/${t2.id}`);
    expect(viewerRead.status).toBe(200);
    expect(viewerRead.body.myRole).toBe('VIEWER');
    expect(viewerRead.body.nextActions).toEqual([]);
    expect((await a.outsider.post(`/v1/transfers/${t2.id}/authorize`, {})).status).toBe(403);
    expect((await a.outsider.post(`/v1/transfers/${t2.id}/cancel`, { reason: 'viewer' })).status).toBe(403);
    expect(
      (
        await a.outsider.post('/v1/transfers', {
          quoteId: (await requestQuote(a.owner, { organizationId: org.body.id })).id,
          beneficiaryId: b2.id,
        })
      ).status,
    ).toBe(403);
    const viewerList = await a.outsider.get(`/v1/transfers?organizationId=${org.body.id}`);
    expect(viewerList.status).toBe(200);
    expect(viewerList.body.total).toBe(1);
  });
});

describe('TRANSFER_PROCESSING job', () => {
  it('auto-settles PROCESSING transfers older than a minute and expires stale quotes', async () => {
    const registry = ctx.app.get(JobRegistry);
    expect(registry.has('TRANSFER_PROCESSING')).toBe(true);
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '2000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const { transfer: old } = await quoteAndCreate(a.owner, beneficiary.id);
    expect((await a.owner.post(`/v1/transfers/${old.id}/authorize`, {})).body.status).toBe('PROCESSING');
    const { transfer: fresh } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '100.00' });
    expect((await a.owner.post(`/v1/transfers/${fresh.id}/authorize`, {})).body.status).toBe('PROCESSING');
    const { quote: staleQuote, transfer: stale } = await quoteAndCreate(a.owner, beneficiary.id, {
      amount: '10.00',
    });
    await ctx.prisma.transfer.update({
      where: { id: old.id },
      data: { processingAt: new Date(Date.now() - 2 * 60_000) },
    });
    await ctx.prisma.fXQuote.update({
      where: { id: staleQuote.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const run = await ctx.app.get(MaintenanceService).run('TRANSFER_PROCESSING', 'test');
    expect(run.status).toBe('COMPLETED');
    expect(run.summary).toMatchObject({ due: 1, settled: 1, failed: 0, expired: 1 });

    expect((await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('SETTLED');
    expect((await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(
      'PROCESSING',
    );
    expect((await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
    expect(await balanceOf(ctx, fxClearingCode('XOF'))).toBe(-DESTINATION_MINOR);
    const settledEvent = await ctx.prisma.providerEvent.findUnique({
      where: { idempotencyKey: `${SANDBOX_PROVIDER_CODE}:${old.reference}:SETTLED` },
    });
    expect(settledEvent?.status).toBe('PROCESSED');
    expect((settledEvent?.payload as any).triggeredBy).toBe('job:test');

    // Second run: nothing left to do, and the manual partner event afterwards is a replay.
    const second = await ctx.app.get(MaintenanceService).run('TRANSFER_PROCESSING', 'test');
    expect(second.summary).toMatchObject({ due: 0, settled: 0, expired: 0 });
    const replay = await a.owner.post('/v1/sandbox/partner/transfer-events', {
      transferReference: old.reference,
      outcome: 'SETTLED',
    });
    expect(replay.body.replayed).toBe(true);
  });
});
