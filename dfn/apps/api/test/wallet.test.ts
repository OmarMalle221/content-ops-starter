import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { walletAccountCode } from '@dfn/financial-ledger';
import { decryptString } from '../src/common/crypto';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { MEMBER_REVIEW_REASON, toTransferDto } from '../src/modules/transfers/transfer.dto';
import { bootTestApp, registerUser, resetDatabase, type TestContext } from './helpers/app';
import { enableMfa, waitForFreshTotpStep } from './helpers/webauthn';
import { BANK_BENEFICIARY, MOMO_BENEFICIARY, createWalletActors, put, selfDeposit } from './helpers/wallet';

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

describe('beneficiaries', () => {
  it('creates, masks, lists and soft-removes beneficiaries of the acting organisation', async () => {
    const a = await createWalletActors(ctx);
    const created = await a.owner.post('/v1/beneficiaries', BANK_BENEFICIARY);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.organizationId).toBe(a.personalOrgId);
    expect(created.body.status).toBe('ACTIVE');
    expect(created.body.accountIdentifierMasked).toBe('••••7890');
    expect(JSON.stringify(created.body)).not.toContain('0152');
    expect(created.body.accountIdentifier).toBeUndefined();
    expect(created.body.accountIdentifierEnc).toBeUndefined();
    expect(Object.keys(created.body).sort()).toEqual(
      [
        'id',
        'organizationId',
        'name',
        'country',
        'currencyCode',
        'method',
        'accountIdentifierMasked',
        'institutionName',
        'phone',
        'email',
        'status',
        'createdAt',
      ].sort(),
    );

    // Encrypted at rest, decryptable only with the document key.
    const row = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.accountIdentifierEnc).not.toContain('SN08');
    expect(decryptString(process.env.DOCUMENT_ENCRYPTION_KEY!, row.accountIdentifierEnc)).toBe(
      'SN08SN0101520000001234567890',
    );

    // Audit + notification + risk facts were recorded.
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'beneficiary.created', entityId: created.body.id },
    });
    expect(audit?.organizationId).toBe(a.personalOrgId);
    const notif = await ctx.prisma.notification.findFirst({
      where: { userId: a.ownerUser.id, type: 'beneficiary.added' },
    });
    expect(notif?.title).toBe('Bénéficiaire ajouté');

    const momo = await a.owner.post('/v1/beneficiaries', {
      ...MOMO_BENEFICIARY,
      organizationId: a.personalOrgId,
    });
    expect(momo.status, JSON.stringify(momo.body)).toBe(201);
    expect(momo.body.accountIdentifierMasked).toBe('••••4567');

    const list = await a.owner.get(`/v1/beneficiaries?organizationId=${a.personalOrgId}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const defaultList = await a.owner.get('/v1/beneficiaries');
    expect(defaultList.body.items).toHaveLength(2);

    const removed = await a.owner.delete(`/v1/beneficiaries/${created.body.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.status).toBe('REMOVED');
    const afterRemoval = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(afterRemoval.removedAt).not.toBeNull();

    const active = await a.owner.get(`/v1/beneficiaries?organizationId=${a.personalOrgId}`);
    expect(active.body.items.map((b: any) => b.id)).toEqual([momo.body.id]);
    const all = await a.owner.get(`/v1/beneficiaries?organizationId=${a.personalOrgId}&includeRemoved=true`);
    expect(all.body.items).toHaveLength(2);

    // Removing twice is an invalid transition.
    const again = await a.owner.delete(`/v1/beneficiaries/${created.body.id}`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('validates mobile money identifiers', async () => {
    const a = await createWalletActors(ctx);
    const bad = await a.owner.post('/v1/beneficiaries', {
      ...MOMO_BENEFICIARY,
      accountIdentifier: 'WAVE-12345',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('never stores the mobile-money identifier in the clear-text phone field', async () => {
    const a = await createWalletActors(ctx, '-phone');
    const created = await a.owner.post('/v1/beneficiaries', {
      ...MOMO_BENEFICIARY,
      accountIdentifier: '+221 77 999 88 77',
      phone: '+221779998877',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.phone).toBeNull();
    expect(JSON.stringify(created.body)).not.toContain('99988');
    const other = await a.owner.post('/v1/beneficiaries', {
      ...MOMO_BENEFICIARY,
      accountIdentifier: '+221770001122',
      phone: '+221 70 123 45 67',
    });
    expect(other.status).toBe(201);
    expect(other.body.phone).toBe('+221 70 123 45 67');
  });

  it('isolates tenants (404) and enforces org roles (403)', async () => {
    const a = await createWalletActors(ctx);
    const mine = await a.owner.post('/v1/beneficiaries', {
      ...BANK_BENEFICIARY,
      organizationId: a.businessOrgId,
    });
    expect(mine.status).toBe(201);

    // Another tenant cannot see, create for or remove from this organisation.
    expect((await a.outsider.get(`/v1/beneficiaries?organizationId=${a.businessOrgId}`)).status).toBe(404);
    expect(
      (await a.outsider.post('/v1/beneficiaries', { ...BANK_BENEFICIARY, organizationId: a.businessOrgId }))
        .status,
    ).toBe(404);
    expect((await a.outsider.delete(`/v1/beneficiaries/${mine.body.id}`)).status).toBe(404);
    const outsiderList = await a.outsider.get('/v1/beneficiaries');
    expect(outsiderList.body.items).toHaveLength(0);

    // A VIEWER may read but not manage.
    const viewerList = await a.viewer.get(`/v1/beneficiaries?organizationId=${a.businessOrgId}`);
    expect(viewerList.status).toBe(200);
    expect(viewerList.body.items).toHaveLength(1);
    const denied = await a.viewer.post('/v1/beneficiaries', {
      ...MOMO_BENEFICIARY,
      organizationId: a.businessOrgId,
    });
    expect(denied.status).toBe(403);
    expect((await a.viewer.delete(`/v1/beneficiaries/${mine.body.id}`)).status).toBe(403);
    const still = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: mine.body.id } });
    expect(still.status).toBe('ACTIVE');
  });
});

describe('conversion estimate', () => {
  it('computes 100.00 CAD → XOF with integer math and the fee charged on top of the converted amount', async () => {
    const { client } = await registerUser(ctx, 'fx@example.com');
    const res = await client.post('/v1/wallets/estimate', {
      sourceCurrency: 'CAD',
      destinationCurrency: 'XOF',
      amount: '100.00',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.provider).toBe('sandbox');
    expect(res.body.spreadBps).toBe(150);
    expect(res.body.source).toEqual({ minor: '10000', decimal: '100.00', currency: 'CAD' });
    // 440 × (1 − 1.5 %) = 433.4 → 100 CAD = 43 340 XOF gross
    expect(res.body.destination).toEqual({ minor: '43340', decimal: '43340', currency: 'XOF' });
    expect(res.body.rate.numerator).toBe('4334000');
    expect(res.body.rate.denominator).toBe('10000');
    expect(res.body.rate.display).toBe('1 CAD = 433.400000 XOF');
    // fee = 2.99 fixed + 0.75 % of 100.00 = 3.74 CAD
    expect(res.body.fee.minor).toBe('374');
    expect(res.body.fee.currency).toBe('CAD');
    // The full amount is converted (same model as the executable quote); the fee is debited on top.
    expect(res.body.netSource.minor).toBe('10000');
    expect(res.body.estimatedReceived).toEqual({ minor: '43340', decimal: '43340', currency: 'XOF' });
    expect(res.body.totalDebit).toEqual({ minor: '10374', decimal: '103.74', currency: 'CAD' });
    expect(typeof res.body.asOf).toBe('string');
    // Nothing persisted
    expect(await ctx.prisma.fXQuote.count()).toBe(0);
  });

  it('handles same-currency and rejects impossible inputs', async () => {
    const { client } = await registerUser(ctx, 'fx2@example.com');
    const same = await client.post('/v1/wallets/estimate', {
      sourceCurrency: 'EUR',
      destinationCurrency: 'EUR',
      amount: '50',
    });
    expect(same.status).toBe(200);
    expect(same.body.spreadBps).toBe(0);
    expect(same.body.destination.minor).toBe('5000');
    expect(same.body.estimatedReceived.minor).toBe('5000');
    expect(same.body.totalDebit.minor).toBe((5000 + 249 + 38).toString());

    // A tiny amount is still convertible: the fee is charged on top, not deducted.
    const tiny = await client.post('/v1/wallets/estimate', {
      sourceCurrency: 'CAD',
      destinationCurrency: 'XOF',
      amount: '1.00',
    });
    expect(tiny.status, JSON.stringify(tiny.body)).toBe(200);
    expect(BigInt(tiny.body.totalDebit.minor)).toBeGreaterThan(100n);
    const zero = await client.post('/v1/wallets/estimate', {
      sourceCurrency: 'CAD',
      destinationCurrency: 'XOF',
      amount: '0.00',
    });
    expect(zero.status).toBe(400);
    const unsupported = await client.post('/v1/wallets/estimate', {
      sourceCurrency: 'CAD',
      destinationCurrency: 'NGN',
      amount: '10.00',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('sandbox self-deposit', () => {
  it('posts a balanced simulated deposit and credits the wallet', async () => {
    const a = await createWalletActors(ctx);
    const res = await selfDeposit(a.owner, a.personalOrgId, 'CAD', '1250.50');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.replayed).toBe(false);
    expect(res.body.newBalance).toEqual({ minor: '125050', decimal: '1250.50', currency: 'CAD' });
    expect(res.body.dailyCap.limit.decimal).toBe('50000.00');
    expect(res.body.dailyCap.usedToday.decimal).toBe('1250.50');
    expect(res.body.dailyCap.remaining.decimal).toBe('48749.50');

    const ledgerTx = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { id: res.body.ledgerTransactionId },
      include: { entries: { include: { account: true } } },
    });
    expect(ledgerTx.kind).toBe('DEPOSIT');
    expect(ledgerTx.reference).toBe(a.personalOrgId);
    expect(ledgerTx.description.toLowerCase()).toContain('simulated');
    expect((ledgerTx.metadata as any).selfService).toBe(true);
    expect(ledgerTx.entries).toHaveLength(2);
    const debit = ledgerTx.entries.find((e) => e.direction === 'DEBIT')!;
    const credit = ledgerTx.entries.find((e) => e.direction === 'CREDIT')!;
    expect(debit.account.code).toBe('PROVIDER_SETTLEMENT:SANDBOX_PARTNER:CAD');
    expect(credit.account.code).toBe(walletAccountCode(a.personalOrgId, 'CAD'));
    expect(debit.amountMinor).toBe(credit.amountMinor);
    expect(credit.amountMinor).toBe(125050n);

    const balances = await a.owner.get(`/v1/wallets/${a.personalOrgId}`);
    expect(balances.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.minor).toBe('125050');

    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'sandbox.wallet_self_deposit', organizationId: a.personalOrgId },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.notification.count({ where: { userId: a.ownerUser.id, type: 'wallet.self_deposit' } }),
    ).toBe(1);
  });

  it('is idempotent on a client-provided key', async () => {
    const a = await createWalletActors(ctx);
    const key = 'client-key-0001';
    const first = await selfDeposit(a.owner, a.personalOrgId, 'XOF', '15000', key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await selfDeposit(a.owner, a.personalOrgId, 'XOF', '15000', key);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.ledgerTransactionId).toBe(first.body.ledgerTransactionId);
    expect(second.body.newBalance.minor).toBe('15000');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { kind: 'DEPOSIT' } })).toBe(1);
    // The same key used by another organisation is a different posting (keys are tenant-scoped).
    const other = await selfDeposit(a.owner, a.businessOrgId, 'XOF', '15000', key);
    expect(other.status).toBe(200);
    expect(other.body.replayed).toBe(false);
    expect(other.body.ledgerTransactionId).not.toBe(first.body.ledgerTransactionId);
  });

  it('enforces the daily cap per organisation and currency', async () => {
    const a = await createWalletActors(ctx);
    const full = await selfDeposit(a.owner, a.personalOrgId, 'CAD', '50000.00');
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.dailyCap.remaining.minor).toBe('0');
    const over = await selfDeposit(a.owner, a.personalOrgId, 'CAD', '0.01');
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('SANDBOX_LIMIT_REACHED');
    expect(over.body.details.remaining.minor).toBe('0');
    // Other currency and other organisation have their own cap.
    expect((await selfDeposit(a.owner, a.personalOrgId, 'XOF', '50000')).status).toBe(200);
    expect((await selfDeposit(a.owner, a.personalOrgId, 'XOF', '1')).status).toBe(409);
    expect((await selfDeposit(a.owner, a.businessOrgId, 'CAD', '10.00')).status).toBe(200);
    // Balance reflects only the accepted postings.
    const balances = await a.owner.get(`/v1/wallets/${a.personalOrgId}`);
    expect(balances.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.minor).toBe('5000000');
  });

  it('requires membership with transfer rights', async () => {
    const a = await createWalletActors(ctx);
    const outsider = await selfDeposit(a.outsider, a.businessOrgId, 'CAD', '10.00');
    expect(outsider.status).toBe(404);
    const viewer = await selfDeposit(a.viewer, a.businessOrgId, 'CAD', '10.00');
    expect(viewer.status).toBe(403);
    const invalid = await selfDeposit(a.owner, a.businessOrgId, 'CAD', '10.001');
    expect(invalid.status).toBe(400);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { kind: 'DEPOSIT' } })).toBe(0);
  });
});

describe('security preferences', () => {
  it('returns defaults, round-trips updates and audits the change', async () => {
    const { client, user } = await registerUser(ctx, 'prefs@example.com');
    const defaults = await client.get('/v1/users/me/security-preferences');
    expect(defaults.status).toBe(200);
    expect(defaults.body).toMatchObject({
      requireMfaForTransfers: true,
      transferAlerts: true,
      dailyTransferLimit: null,
    });

    const saved = await put(ctx, client, '/v1/users/me/security-preferences', {
      requireMfaForTransfers: false,
      transferAlerts: true,
      dailyTransferLimit: '2500,5',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.requireMfaForTransfers).toBe(false);
    expect(saved.body.dailyTransferLimit).toBe('2500.50');

    const again = await client.get('/v1/users/me/security-preferences');
    expect(again.body).toMatchObject({
      requireMfaForTransfers: false,
      transferAlerts: true,
      dailyTransferLimit: '2500.50',
    });
    const me = await client.get('/v1/users/me');
    expect(me.body.securityPreferences.requireMfaForTransfers).toBe(false);

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'user.security_preferences_updated', actorUserId: user.id },
    });
    expect((audit?.metadata as any).changed).toEqual(['requireMfaForTransfers', 'dailyTransferLimit']);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: user.id, type: 'user.security_preferences_updated' },
      }),
    ).toBe(1);

    const cleared = await put(ctx, client, '/v1/users/me/security-preferences', {
      requireMfaForTransfers: true,
      transferAlerts: false,
      dailyTransferLimit: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.dailyTransferLimit).toBeNull();

    const invalid = await put(ctx, client, '/v1/users/me/security-preferences', {
      dailyTransferLimit: 'abc',
    });
    expect(invalid.status).toBe(400);
    expect((await ctx.http().get('/v1/users/me/security-preferences')).status).toBe(401);
  });

  it('requires a TOTP code to lower the protections of a user with MFA enabled', async () => {
    const { client, user } = await registerUser(ctx, 'mfa-prefs@example.com');
    const url = '/v1/users/me/security-preferences';
    const strict = { requireMfaForTransfers: true, transferAlerts: true, dailyTransferLimit: '1000.00' };
    expect((await put(ctx, client, url, strict)).status).toBe(200);
    const { secret } = await enableMfa(client);

    // Switching the step-up off, raising or removing the limit: refused without a code.
    for (const lowering of [
      { ...strict, requireMfaForTransfers: false },
      { ...strict, dailyTransferLimit: '1000.01' },
      { ...strict, dailyTransferLimit: null },
    ]) {
      const refused = await put(ctx, client, url, lowering);
      expect(refused.status, JSON.stringify(lowering)).toBe(401);
      expect(refused.body.code).toBe('MFA_REQUIRED');
    }
    const wrong = await put(ctx, client, url, {
      ...strict,
      requireMfaForTransfers: false,
      mfaCode: '000000',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('MFA_REQUIRED');
    const malformed = await put(ctx, client, url, {
      ...strict,
      requireMfaForTransfers: false,
      mfaCode: '12ab',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_FAILED');
    expect((await client.get(url)).body).toMatchObject(strict);

    // Tightening never needs a code.
    const tightened = await put(ctx, client, url, {
      ...strict,
      transferAlerts: false,
      dailyTransferLimit: '500.00',
    });
    expect(tightened.status, JSON.stringify(tightened.body)).toBe(200);
    expect(tightened.body.dailyTransferLimit).toBe('500.00');

    // A valid code lets the user lower the protections; the code itself is never stored.
    await waitForFreshTotpStep();
    const lowered = await put(ctx, client, url, {
      requireMfaForTransfers: false,
      transferAlerts: false,
      dailyTransferLimit: null,
      mfaCode: authenticator.generate(secret),
    });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    expect(lowered.body.requireMfaForTransfers).toBe(false);
    expect(lowered.body.dailyTransferLimit).toBeNull();
    expect(lowered.body.mfaCode).toBeUndefined();
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.securityPreferences).toEqual({
      requireMfaForTransfers: false,
      transferAlerts: false,
      dailyTransferLimit: null,
    });
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'user.security_preferences_updated', actorUserId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit?.metadata as any).mfaVerified).toBe(true);
  });
});

describe('transfer DTO disclosure', () => {
  it('keeps risk-rule codes and explanations for staff only', () => {
    const reviewReason = 'UNVERIFIED_TRANSFER: unverified user above the threshold';
    const now = new Date();
    const transfer = {
      id: '3f2b1c4d-1111-2222-3333-444444444444',
      reference: 'TRF-000001',
      organizationId: '3f2b1c4d-1111-2222-3333-555555555555',
      createdByUserId: '3f2b1c4d-1111-2222-3333-666666666666',
      status: 'REVIEW_REQUIRED',
      originCountry: 'CA',
      destinationCountry: 'SN',
      sourceCurrency: 'CAD',
      destinationCurrency: 'XOF',
      sourceAmountMinor: 1_500_000n,
      feeMinor: 11_549n,
      destinationAmountMinor: 6_501_000n,
      rateNumerator: 4334n,
      rateDenominator: 10n,
      beneficiary: { name: 'Awa Diop' },
      reviewReason,
      riskScore: 60,
      metadata: null,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          id: 'e1',
          type: 'transfer.review_required',
          actorUserId: null,
          payload: { riskScore: 60, signals: ['UNVERIFIED_TRANSFER'], reason: reviewReason },
          createdAt: now,
        },
        {
          id: 'e2',
          type: 'transfer.quoted',
          actorUserId: null,
          payload: { simulated: true },
          createdAt: now,
        },
      ],
      quote: null,
      provider: null,
    } as any;

    const member = toTransferDto(transfer, { isStaff: false, role: 'OWNER' });
    expect(member.reviewReason).toBe(MEMBER_REVIEW_REASON);
    // Neither the rule nor the risk score reach a member (no threshold probing).
    expect(member.events[0].payload).toEqual({ reason: MEMBER_REVIEW_REASON });
    expect(member.events[1].payload).toEqual({ simulated: true });
    expect(JSON.stringify(member)).not.toContain('UNVERIFIED_TRANSFER');
    expect(member.riskScore).toBeNull();

    const staff = toTransferDto(transfer, { isStaff: true, role: null });
    expect(staff.riskScore).toBe(60);
    expect(staff.reviewReason).toBe(reviewReason);
    expect((staff.events[0].payload as any).signals).toEqual(['UNVERIFIED_TRANSFER']);

    // Without a review there is nothing to hide.
    const plain = toTransferDto({ ...transfer, reviewReason: null }, { isStaff: false, role: 'MEMBER' });
    expect(plain.reviewReason).toBeNull();
  });
});

describe('wallet summary and operations', () => {
  it('exposes balances, recent operations, pending items and statement links', async () => {
    const a = await createWalletActors(ctx);
    const empty = await a.owner.get(`/v1/wallets/${a.personalOrgId}/summary`);
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.simulated).toBe(true);
    expect(empty.body.disclaimer).toBe('Données fictives — Aucun fonds réel');
    expect(empty.body.currencies.map((c: any) => c.currencyCode)).toEqual([
      'CAD',
      'USD',
      'EUR',
      'XOF',
      'GNF',
    ]);
    expect(empty.body.pending).toEqual({ awaitingFundingAsBuyer: 0, escrowsHoldingAsSeller: 0 });
    expect(empty.body.links.statements.CAD).toBe(`/v1/wallets/${a.personalOrgId}/CAD/statement.csv`);
    for (const c of empty.body.currencies) {
      expect(c.balance.minor).toBe('0');
      expect(c.recentOperations).toEqual([]);
      expect(c.selfDeposit.remaining.minor).toBe(c.selfDeposit.limit.minor);
      expect(c.statementPath).toBe(`/v1/wallets/${a.personalOrgId}/${c.currencyCode}/statement.csv`);
    }

    expect((await selfDeposit(a.owner, a.personalOrgId, 'CAD', '100.00')).status).toBe(200);
    expect((await selfDeposit(a.owner, a.personalOrgId, 'CAD', '25.00')).status).toBe(200);
    const after = await a.owner.get(`/v1/wallets/${a.personalOrgId}/summary`);
    const cad = after.body.currencies.find((c: any) => c.currencyCode === 'CAD');
    expect(cad.balance).toEqual({ minor: '12500', decimal: '125.00', currency: 'CAD' });
    expect(cad.entryCount).toBe(2);
    expect(cad.recentOperations).toHaveLength(2);
    expect(cad.recentOperations[0].kind).toBe('DEPOSIT');
    expect(cad.recentOperations[0].signedAmount.minor).toBe('2500');
    expect(cad.selfDeposit.usedToday.decimal).toBe('125.00');

    // Viewer of the business org can read its summary; outsiders get 404.
    expect((await a.viewer.get(`/v1/wallets/${a.businessOrgId}/summary`)).status).toBe(200);
    expect((await a.outsider.get(`/v1/wallets/${a.personalOrgId}/summary`)).status).toBe(404);
  });

  it('filters operations by kind, status and date range and exports them as CSV', async () => {
    const a = await createWalletActors(ctx);
    expect((await selfDeposit(a.owner, a.personalOrgId, 'EUR', '40.00')).status).toBe(200);
    const base = `/v1/wallets/${a.personalOrgId}/EUR`;
    const all = await a.owner.get(`${base}/entries`);
    expect(all.body.total).toBe(1);
    expect((await a.owner.get(`${base}/entries?kind=DEPOSIT&status=POSTED`)).body.total).toBe(1);
    expect((await a.owner.get(`${base}/entries?kind=RELEASE`)).body.total).toBe(0);
    expect((await a.owner.get(`${base}/entries?status=REVERSED`)).body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await a.owner.get(`${base}/entries?from=${today}&to=${today}`)).body.total).toBe(1);
    expect((await a.owner.get(`${base}/entries?from=2000-01-01&to=2000-01-31`)).body.total).toBe(0);
    expect((await a.owner.get(`${base}/entries?from=2030-01-01&to=2000-01-01`)).status).toBe(400);
    expect((await a.owner.get(`${base}/entries?kind=NOPE`)).status).toBe(400);
    expect((await a.outsider.get(`${base}/entries`)).status).toBe(404);

    const csv = await a.owner.get(`${base}/statement.csv?kind=DEPOSIT&from=${today}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.split('\n');
    expect(lines[0]).toContain('Données fictives — Aucun fonds réel');
    expect(lines[1]).toBe(
      'posted_at,kind,description,reference,signed_amount,currency,status,ledger_transaction_id',
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(',DEPOSIT,');
    expect(lines[2]).toContain(',40.00,EUR,POSTED,');
    const filteredOut = await a.owner.get(`${base}/statement.csv?kind=REFUND`);
    expect(filteredOut.text.split('\n')).toHaveLength(2);
  });
});
