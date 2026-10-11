import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ddaHoldingCode, ddaIssuanceCode } from '@dfn/financial-ledger';
import { CURRENCIES } from '@dfn/shared';
import { DdaRegistryService } from '../src/modules/dda/dda-registry.service';
import { coverageRatioBps, percentToBps, runStressTest } from '../src/modules/dda/dda-stress';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import {
  Client,
  PASSWORD,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
  await ctx.app.get(DdaRegistryService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

const REFERENCE_RE = /^DDA-\d{4}-[A-Z0-9]{6}$/;

async function staff(role: 'ADMIN' | 'COMPLIANCE', email: string) {
  const { user } = await registerUser(ctx, email);
  await promote(ctx, email, role);
  const client = new Client(ctx);
  const login = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { client, user, orgId: user.organizations[0].id as string };
}

async function tenants() {
  const a = await registerUser(ctx, 'alpha@example.com', { firstName: 'Alpha', lastName: 'Diop' });
  const b = await registerUser(ctx, 'beta@example.com', { firstName: 'Beta', lastName: 'Sow' });
  return {
    alpha: a.client,
    alphaOrg: a.user.organizations[0].id as string,
    beta: b.client,
    betaOrg: b.user.organizations[0].id as string,
  };
}

async function registryState() {
  const registry = ctx.app.get(DdaRegistryService);
  const supply = await registry.supplyMinor();
  const holdings = await registry.holdings();
  const sum = holdings.reduce((acc, h) => acc + h.balanceMinor, 0n);
  const byOrg = new Map(holdings.map((h) => [h.organizationId, h.balanceMinor]));
  return { supply, sum, byOrg };
}

function expectSimulated(body: any) {
  expect(body.simulated).toBe(true);
  expect(typeof body.disclaimer).toBe('string');
  expect(body.disclaimer).toContain('non garantie');
  expect(body.hypothesis).toContain('1 DDA = 1 USD');
}

describe('pure helpers (coverage and stress test)', () => {
  it('computes the coverage ratio in basis points with integer arithmetic', () => {
    expect(coverageRatioBps(0n, 100n)).toBeNull();
    expect(coverageRatioBps(100_000n, 80_000n)).toBe(8000);
    expect(coverageRatioBps(100_000n, 120_000n)).toBe(12_000);
    expect(coverageRatioBps(100_000n, 0n)).toBe(0);
    expect(coverageRatioBps(100_000n, -5n)).toBe(0);
    expect(coverageRatioBps(3n, 1n)).toBe(3333);
  });

  it('converts percentages to clamped basis points', () => {
    expect(percentToBps(12.5)).toBe(1250n);
    expect(percentToBps(30)).toBe(3000n);
    expect(percentToBps(150)).toBe(10_000n);
    expect(percentToBps(-3)).toBe(0n);
    expect(percentToBps(Number.NaN)).toBe(0n);
  });

  it('returns COVERED when the reserve after haircut absorbs the redemptions', () => {
    const r = runStressTest({
      supplyMinor: 100_000n,
      reserveUsdMinor: 80_000n,
      redemptionPercent: 30,
      reserveHaircutPercent: 0,
    });
    expect(r.redeemedUnitsMinor).toBe(30_000n);
    expect(r.remainingSupplyMinor).toBe(70_000n);
    expect(r.reserveAfterHaircutMinor).toBe(80_000n);
    expect(r.reserveAfterRedemptionsMinor).toBe(50_000n);
    expect(r.shortfallUsdMinor).toBe(0n);
    expect(r.coverageBeforeBps).toBe(8000);
    expect(r.coverageAfterBps).toBe(7142);
    expect(r.verdict).toBe('COVERED');
    expect(r.notes.some((n) => n.includes('non garantie'))).toBe(true);
  });

  it('returns SHORTFALL with the uncovered amount when redemptions exceed the haircut reserve', () => {
    const r = runStressTest({
      supplyMinor: 100_000n,
      reserveUsdMinor: 50_000n,
      redemptionPercent: 80,
      reserveHaircutPercent: 20,
    });
    expect(r.redeemedUnitsMinor).toBe(80_000n);
    expect(r.reserveAfterHaircutMinor).toBe(40_000n);
    expect(r.reserveAfterRedemptionsMinor).toBe(-40_000n);
    expect(r.shortfallUsdMinor).toBe(40_000n);
    expect(r.coverageAfterBps).toBe(0);
    expect(r.verdict).toBe('SHORTFALL');
  });

  it('handles an empty supply and a full haircut without dividing by zero', () => {
    const empty = runStressTest({
      supplyMinor: 0n,
      reserveUsdMinor: 0n,
      redemptionPercent: 100,
      reserveHaircutPercent: 100,
    });
    expect(empty.verdict).toBe('COVERED');
    expect(empty.coverageBeforeBps).toBeNull();
    expect(empty.coverageAfterBps).toBeNull();
    const wiped = runStressTest({
      supplyMinor: 10_000n,
      reserveUsdMinor: 10_000n,
      redemptionPercent: 100,
      reserveHaircutPercent: 100,
    });
    expect(wiped.reserveAfterHaircutMinor).toBe(0n);
    expect(wiped.shortfallUsdMinor).toBe(10_000n);
    expect(wiped.remainingSupplyMinor).toBe(0n);
    expect(wiped.coverageAfterBps).toBeNull();
    expect(wiped.verdict).toBe('SHORTFALL');
  });
});

describe('authorisation — the DDA lab is never exposed outside platform administrators', () => {
  it('rejects anonymous, USER and COMPLIANCE callers', async () => {
    const anon = await ctx.http().get('/v1/admin/dda/overview');
    expect(anon.status).toBe(401);

    const { client: user, orgId } = await (async () => {
      const r = await registerUser(ctx, 'plain@example.com');
      return { client: r.client, orgId: r.user.organizations[0].id as string };
    })();
    expect((await user.get('/v1/admin/dda/overview')).status).toBe(403);
    expect((await user.get('/v1/admin/dda/holdings')).status).toBe(403);
    expect((await user.get('/v1/admin/dda/operations')).status).toBe(403);
    expect((await user.get('/v1/admin/dda/organizations')).status).toBe(403);
    const mint = await user.post('/v1/admin/dda/mint', { organizationId: orgId, units: '10.00' });
    expect(mint.status).toBe(403);
    expect(mint.body.code).toBe('FORBIDDEN');
    expect((await user.post('/v1/admin/dda/stress-test', {})).status).toBe(403);

    const { client: compliance } = await staff('COMPLIANCE', 'compliance@example.com');
    expect((await compliance.get('/v1/admin/dda/overview')).status).toBe(403);
    expect(
      (await compliance.post('/v1/admin/dda/mint', { organizationId: orgId, units: '10.00' })).status,
    ).toBe(403);
    expect(
      (await compliance.post('/v1/admin/dda/reserve-adjustments', { deltaUsd: '10.00', note: 'test note' }))
        .status,
    ).toBe(403);
    expect((await compliance.get('/v1/admin/dda/trace/DDA-2026-ABCDEF')).status).toBe(403);

    // Nothing was created by the refused calls.
    expect(await ctx.prisma.digitalAssetSimulation.count()).toBe(0);
  });
});

describe('registry', () => {
  it('registers the simulated currency and the issuance account, and survives ReferenceDataService.ensure()', async () => {
    const before = await ctx.prisma.currency.findUnique({ where: { code: 'DDA' } });
    expect(before?.kind).toBe('SIMULATED_ASSET');
    expect(before?.isActive).toBe(true);
    expect(before?.exponent).toBe(2);
    expect(before?.name).toContain('fictive');

    await ctx.app.get(ReferenceDataService).ensure();
    const after = await ctx.prisma.currency.findUnique({ where: { code: 'DDA' } });
    expect(after?.kind).toBe('SIMULATED_ASSET');
    expect(after?.isActive).toBe(true);

    const issuance = await ctx.prisma.ledgerAccount.findUnique({ where: { code: ddaIssuanceCode() } });
    expect(issuance).toMatchObject({
      type: 'ASSET',
      normalBalance: 'DEBIT',
      currencyCode: 'DDA',
      ownerType: 'PLATFORM',
      allowNegative: true,
    });
    // Fiat currencies keep their FIAT kind.
    const cad = await ctx.prisma.currency.findUnique({ where: { code: 'CAD' } });
    expect(cad?.kind).toBe('FIAT');
  });

  it('keeps DDA out of the fiat wallet surfaces', async () => {
    const { client: admin } = await staff('ADMIN', 'admin@example.com');
    const { alpha, alphaOrg } = await tenants();
    const mint = await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '250.00' });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const wallets = await alpha.get(`/v1/wallets/${alphaOrg}`);
    expect(wallets.status).toBe(200);
    const codes = wallets.body.wallets.map((w: any) => w.currencyCode);
    expect(codes).not.toContain('DDA');
    expect(codes.sort()).toEqual(Object.keys(CURRENCIES).sort());
    // No wallet row was ever created for the simulated asset.
    expect(await ctx.prisma.wallet.count({ where: { currencyCode: 'DDA' } })).toBe(0);
  });
});

describe('simulators — mint / transfer / redeem keep supply = Σ holdings', () => {
  it('mints fictitious units with a balanced posting, audit, notification and simulated reserve', async () => {
    const { client: admin, user: adminUser } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg } = await tenants();
    const res = await admin.post('/v1/admin/dda/mint', {
      organizationId: alphaOrg,
      units: '1000.00',
      reserveUsd: '800.00',
      note: 'Scénario de base',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expectSimulated(res.body);
    expect(res.body.reference).toMatch(REFERENCE_RE);
    expect(res.body.operation).toBe('MINT');
    expect(res.body.status).toBe('MINTED');
    expect(res.body.units).toEqual({ minor: '100000', decimal: '1000.00', currency: 'DDA' });
    expect(res.body.reserveDeltaUsd).toEqual({ minor: '80000', decimal: '800.00', currency: 'USD' });
    expect(res.body.organization.id).toBe(alphaOrg);
    expect(res.body.createdBy.id).toBe(adminUser.id);
    expect(res.body.metadata.hypothesis).toBe('1 DDA = 1 USD (non garantie)');

    const state = await registryState();
    expect(state.supply).toBe(100_000n);
    expect(state.sum).toBe(100_000n);
    expect(state.byOrg.get(alphaOrg)).toBe(100_000n);

    const ledgerTx = await ctx.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `dda:${res.body.reference}` },
      include: { entries: { include: { account: true } } },
    });
    expect(ledgerTx).not.toBeNull();
    expect(ledgerTx!.id).toBe(res.body.ledgerTransactionId);
    expect(ledgerTx!.reference).toBe(res.body.reference);
    expect((ledgerTx!.metadata as any).simulated).toBe(true);
    expect((ledgerTx!.metadata as any).hypothesis).toBe('1 DDA = 1 USD (non garantie)');
    expect(ledgerTx!.entries).toHaveLength(2);
    const debit = ledgerTx!.entries.find((e) => e.direction === 'DEBIT')!;
    const credit = ledgerTx!.entries.find((e) => e.direction === 'CREDIT')!;
    expect(debit.account.code).toBe(ddaIssuanceCode());
    expect(credit.account.code).toBe(ddaHoldingCode(alphaOrg));
    expect(debit.currencyCode).toBe('DDA');
    expect(credit.currencyCode).toBe('DDA');

    // The simulated USD reserve never touches the fiat ledger.
    const fiatEntries = await ctx.prisma.ledgerEntry.count({ where: { currencyCode: { not: 'DDA' } } });
    expect(fiatEntries).toBe(0);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'DigitalAssetSimulation', entityId: res.body.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('dda.mint');
    expect(audit[0].actorUserId).toBe(adminUser.id);
    expect((audit[0].metadata as any).simulated).toBe(true);

    const notifications = await ctx.prisma.notification.findMany({ where: { type: 'dda.operation' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(adminUser.id);
    expect(notifications[0].body).toContain('non garantie');

    const overview = await admin.get('/v1/admin/dda/overview');
    expect(overview.status).toBe(200);
    expectSimulated(overview.body);
    expect(overview.body.supply.decimal).toBe('1000.00');
    expect(overview.body.reserveUsd.decimal).toBe('800.00');
    expect(overview.body.coverageRatioBps).toBe(8000);
    expect(overview.body.holdersCount).toBe(1);
    expect(overview.body.invariantHolds).toBe(true);
    expect(overview.body.topHoldings[0].organization.id).toBe(alphaOrg);
    expect(overview.body.topHoldings[0].shareBps).toBe(10_000);
    expect(overview.body.lastOperations[0].reference).toBe(res.body.reference);
  });

  it('transfers between holdings and refuses overdrafts, self-transfers and unknown organisations', async () => {
    const { client: admin } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg, betaOrg } = await tenants();
    await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '1000.00' });

    const ok = await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: alphaOrg,
      toOrganizationId: betaOrg,
      units: '400.00',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expectSimulated(ok.body);
    expect(ok.body.operation).toBe('TRANSFER');
    expect(ok.body.status).toBe('TRANSFERRED');
    expect(ok.body.organization.id).toBe(alphaOrg);
    expect(ok.body.counterparty.id).toBe(betaOrg);

    let state = await registryState();
    expect(state.supply).toBe(100_000n);
    expect(state.sum).toBe(100_000n);
    expect(state.byOrg.get(alphaOrg)).toBe(60_000n);
    expect(state.byOrg.get(betaOrg)).toBe(40_000n);

    const overdraft = await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: betaOrg,
      toOrganizationId: alphaOrg,
      units: '400.01',
    });
    expect(overdraft.status).toBe(409);
    expect(overdraft.body.code).toBe('INSUFFICIENT_FUNDS');

    const self = await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: alphaOrg,
      toOrganizationId: alphaOrg,
      units: '1.00',
    });
    expect(self.status).toBe(400);

    const unknown = await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: alphaOrg,
      toOrganizationId: '00000000-0000-4000-8000-000000000000',
      units: '1.00',
    });
    expect(unknown.status).toBe(404);

    // Failed attempts leave no trace in the registry nor in the simulation table.
    state = await registryState();
    expect(state.supply).toBe(100_000n);
    expect(state.sum).toBe(100_000n);
    expect(await ctx.prisma.digitalAssetSimulation.count()).toBe(2);
  });

  it('redeems units back to the issuance account and refuses redemptions beyond the balance (409)', async () => {
    const { client: admin } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg } = await tenants();
    await admin.post('/v1/admin/dda/mint', {
      organizationId: alphaOrg,
      units: '1000.00',
      reserveUsd: '1000.00',
    });

    const tooMuch = await admin.post('/v1/admin/dda/redeem', { organizationId: alphaOrg, units: '1000.01' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('INSUFFICIENT_FUNDS');

    const ok = await admin.post('/v1/admin/dda/redeem', { organizationId: alphaOrg, units: '600.00' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expectSimulated(ok.body);
    expect(ok.body.operation).toBe('REDEEM');
    expect(ok.body.status).toBe('REDEEMED');
    expect(ok.body.reserveDeltaUsd.minor).toBe('0');

    const state = await registryState();
    expect(state.supply).toBe(40_000n);
    expect(state.sum).toBe(40_000n);
    expect(state.byOrg.get(alphaOrg)).toBe(40_000n);

    const ledgerTx = await ctx.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `dda:${ok.body.reference}` },
      include: { entries: { include: { account: true } } },
    });
    expect(ledgerTx!.entries.find((e) => e.direction === 'DEBIT')!.account.code).toBe(
      ddaHoldingCode(alphaOrg),
    );
    expect(ledgerTx!.entries.find((e) => e.direction === 'CREDIT')!.account.code).toBe(ddaIssuanceCode());
    // Redemption does not release the simulated reserve by itself: coverage rises, nothing is paid out.
    const overview = await admin.get('/v1/admin/dda/overview');
    expect(overview.body.reserveUsd.decimal).toBe('1000.00');
    expect(overview.body.coverageRatioBps).toBe(25_000);
    expect(await ctx.prisma.ledgerEntry.count({ where: { currencyCode: { not: 'DDA' } } })).toBe(0);

    const emptied = await admin.post('/v1/admin/dda/redeem', { organizationId: alphaOrg, units: '400.00' });
    expect(emptied.status).toBe(201);
    const final = await registryState();
    expect(final.supply).toBe(0n);
    expect(final.sum).toBe(0n);
    const after = await admin.get('/v1/admin/dda/overview');
    expect(after.body.holdersCount).toBe(0);
    expect(after.body.coverageRatioBps).toBeNull();
  });

  it('refuses any operation outside the DDA currency and invalid amounts', async () => {
    const { client: admin } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg, betaOrg } = await tenants();
    const usd = await admin.post('/v1/admin/dda/mint', {
      organizationId: alphaOrg,
      units: '10.00',
      currencyCode: 'USD',
    });
    expect(usd.status).toBe(400);
    expect(usd.body.code).toBe('VALIDATION_FAILED');
    const cad = await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: alphaOrg,
      toOrganizationId: betaOrg,
      units: '10.00',
      currencyCode: 'CAD',
    });
    expect(cad.status).toBe(400);
    const eur = await admin.post('/v1/admin/dda/redeem', {
      organizationId: alphaOrg,
      units: '10.00',
      currencyCode: 'EUR',
    });
    expect(eur.status).toBe(400);
    expect((await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '0' })).status).toBe(
      400,
    );
    expect((await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '-5' })).status).toBe(
      400,
    );
    expect(
      (await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '1.234' })).status,
    ).toBe(400);
    expect(
      (await admin.post('/v1/admin/dda/mint', { organizationId: 'not-a-uuid', units: '1.00' })).status,
    ).toBe(400);
    const explicit = await admin.post('/v1/admin/dda/mint', {
      organizationId: alphaOrg,
      units: '10.00',
      currencyCode: 'DDA',
    });
    expect(explicit.status).toBe(201);
    expect(await ctx.prisma.ledgerEntry.count({ where: { currencyCode: { not: 'DDA' } } })).toBe(0);
  });
});

describe('simulated reserve, coverage and stress testing', () => {
  it('books reserve adjustments off the fiat ledger and never lets the reserve go negative', async () => {
    const { client: admin, user: adminUser } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg } = await tenants();
    await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '1000.00' });

    const up = await admin.post('/v1/admin/dda/reserve-adjustments', {
      deltaUsd: '500.00',
      note: 'Dépôt simulé en réserve',
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expectSimulated(up.body);
    expect(up.body.operation).toBe('RESERVE_ADJUSTMENT');
    expect(up.body.scope).toBe('PLATFORM');
    expect(up.body.organization).toBeNull();
    expect(up.body.ledgerTransactionId).toBeNull();
    expect(up.body.reserveDeltaUsd).toEqual({ minor: '50000', decimal: '500.00', currency: 'USD' });
    expect(up.body.units.minor).toBe('0');

    const down = await admin.post('/v1/admin/dda/reserve-adjustments', {
      deltaUsd: '-200,00',
      note: 'Retrait simulé',
    });
    expect(down.status, JSON.stringify(down.body)).toBe(201);
    expect(down.body.reserveDeltaUsd.minor).toBe('-20000');

    const negative = await admin.post('/v1/admin/dda/reserve-adjustments', {
      deltaUsd: '-300.01',
      note: 'Trop grand retrait',
    });
    expect(negative.status).toBe(409);
    expect(negative.body.code).toBe('DDA_RESERVE_NEGATIVE');

    expect(
      (await admin.post('/v1/admin/dda/reserve-adjustments', { deltaUsd: '0.00', note: 'zéro' })).status,
    ).toBe(400);
    expect(
      (await admin.post('/v1/admin/dda/reserve-adjustments', { deltaUsd: '10.00', note: 'ab' })).status,
    ).toBe(400);

    const overview = await admin.get('/v1/admin/dda/overview');
    expect(overview.body.reserveUsd.decimal).toBe('300.00');
    expect(overview.body.coverageRatioBps).toBe(3000);
    expect(overview.body.supply.decimal).toBe('1000.00');
    // No ledger movement at all for reserve adjustments, and no fiat posting.
    expect(
      await ctx.prisma.ledgerTransaction.count({ where: { idempotencyKey: `dda:${up.body.reference}` } }),
    ).toBe(0);
    expect(await ctx.prisma.ledgerEntry.count({ where: { currencyCode: { not: 'DDA' } } })).toBe(0);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'dda.reserve_adjustment' } });
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.actorUserId === adminUser.id && a.organizationId === null)).toBe(true);
  });

  it('runs the de-peg / liquidity stress test as a pure computation on the current state', async () => {
    const { client: admin } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg } = await tenants();
    await admin.post('/v1/admin/dda/mint', {
      organizationId: alphaOrg,
      units: '1000.00',
      reserveUsd: '800.00',
    });
    const before = await ctx.prisma.digitalAssetSimulation.count();

    const covered = await admin.post('/v1/admin/dda/stress-test', {
      redemptionPercent: 30,
      reserveHaircutPercent: 0,
    });
    expect(covered.status, JSON.stringify(covered.body)).toBe(200);
    expectSimulated(covered.body);
    expect(covered.body.verdict).toBe('COVERED');
    expect(covered.body.redeemedUnits.decimal).toBe('300.00');
    expect(covered.body.reserveAfterHaircut.decimal).toBe('800.00');
    expect(covered.body.reserveAfterRedemptions.decimal).toBe('500.00');
    expect(covered.body.shortfallUsd.decimal).toBe('0.00');
    expect(covered.body.coverageAfterBps).toBe(7142);
    expect(Array.isArray(covered.body.notes)).toBe(true);

    const shortfall = await admin.post('/v1/admin/dda/stress-test', {
      redemptionPercent: 90,
      reserveHaircutPercent: 25,
    });
    expect(shortfall.status).toBe(200);
    expect(shortfall.body.verdict).toBe('SHORTFALL');
    expect(shortfall.body.reserveAfterHaircut.decimal).toBe('600.00');
    expect(shortfall.body.redeemedUnits.decimal).toBe('900.00');
    expect(shortfall.body.shortfallUsd.decimal).toBe('300.00');
    expect(shortfall.body.coverageAfterBps).toBe(0);

    const defaults = await admin.post('/v1/admin/dda/stress-test', {});
    expect(defaults.status).toBe(200);
    expect(defaults.body.inputs).toMatchObject({ redemptionPercent: 30, reserveHaircutPercent: 0 });

    expect((await admin.post('/v1/admin/dda/stress-test', { redemptionPercent: 101 })).status).toBe(400);
    expect((await admin.post('/v1/admin/dda/stress-test', { reserveHaircutPercent: -1 })).status).toBe(400);

    // Pure computation: nothing was written.
    expect(await ctx.prisma.digitalAssetSimulation.count()).toBe(before);
    const state = await registryState();
    expect(state.supply).toBe(100_000n);
  });
});

describe('read models and traceability', () => {
  it('lists operations, holdings and organisations with the simulation envelope everywhere', async () => {
    const { client: admin } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg, betaOrg } = await tenants();
    await admin.post('/v1/admin/dda/mint', {
      organizationId: alphaOrg,
      units: '1000.00',
      reserveUsd: '1000.00',
    });
    await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: alphaOrg,
      toOrganizationId: betaOrg,
      units: '250.00',
    });
    await admin.post('/v1/admin/dda/redeem', { organizationId: betaOrg, units: '50.00' });
    await admin.post('/v1/admin/dda/reserve-adjustments', { deltaUsd: '-100.00', note: 'Retrait simulé' });

    const page1 = await admin.get('/v1/admin/dda/operations?page=1&pageSize=3');
    expect(page1.status).toBe(200);
    expectSimulated(page1.body);
    expect(page1.body.total).toBe(4);
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.items[0].operation).toBe('RESERVE_ADJUSTMENT');
    expect(page1.body.items.every((i: any) => i.simulated === true)).toBe(true);
    const page2 = await admin.get('/v1/admin/dda/operations?page=2&pageSize=3');
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].operation).toBe('MINT');

    const holdings = await admin.get('/v1/admin/dda/holdings');
    expect(holdings.status).toBe(200);
    expectSimulated(holdings.body);
    expect(holdings.body.supply.decimal).toBe('950.00');
    expect(holdings.body.invariantHolds).toBe(true);
    expect(holdings.body.items.map((h: any) => [h.organization.id, h.balance.decimal])).toEqual([
      [alphaOrg, '750.00'],
      [betaOrg, '200.00'],
    ]);
    expect(holdings.body.items[0].organization.name).toBeTruthy();
    expect(holdings.body.items[0].shareBps + holdings.body.items[1].shareBps).toBeLessThanOrEqual(10_000);

    const orgs = await admin.get('/v1/admin/dda/organizations');
    expect(orgs.status).toBe(200);
    expectSimulated(orgs.body);
    const ids = orgs.body.items.map((o: any) => o.id);
    expect(ids).toContain(alphaOrg);
    expect(ids).toContain(betaOrg);
    expect(orgs.body.items[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), name: expect.any(String), type: expect.any(String) }),
    );

    const overview = await admin.get('/v1/admin/dda/overview');
    expect(overview.body.operationsCount).toBe(4);
    expect(overview.body.reserveUsd.decimal).toBe('900.00');
    expect(overview.body.coverageRatioBps).toBe(9473);
    expect(overview.body.holdersCount).toBe(2);
    expect(overview.body.redLines.length).toBeGreaterThan(0);

    for (const path of ['overview', 'operations', 'holdings', 'organizations']) {
      const r = await admin.get(`/v1/admin/dda/${path}`);
      expect(r.status).toBe(200);
      expect(r.body.simulated).toBe(true);
      expect(r.body.disclaimer).toContain('non garantie');
    }
  });

  it('traces an operation to its simulation row, ledger entries and audit trail', async () => {
    const { client: admin, user: adminUser } = await staff('ADMIN', 'admin@example.com');
    const { alphaOrg, betaOrg } = await tenants();
    await admin.post('/v1/admin/dda/mint', { organizationId: alphaOrg, units: '100.00' });
    const transfer = await admin.post('/v1/admin/dda/transfer', {
      fromOrganizationId: alphaOrg,
      toOrganizationId: betaOrg,
      units: '40.00',
      note: 'Traçabilité',
    });
    expect(transfer.status).toBe(201);

    const trace = await admin.get(`/v1/admin/dda/trace/${transfer.body.reference}`);
    expect(trace.status, JSON.stringify(trace.body)).toBe(200);
    expectSimulated(trace.body);
    expect(trace.body.operation.reference).toBe(transfer.body.reference);
    expect(trace.body.operation.note).toBe('Traçabilité');
    expect(trace.body.ledgerTransaction.idempotencyKey).toBe(`dda:${transfer.body.reference}`);
    expect(trace.body.ledgerTransaction.reference).toBe(transfer.body.reference);
    expect(trace.body.ledgerTransaction.status).toBe('POSTED');
    expect(trace.body.ledgerTransaction.entries).toHaveLength(2);
    const codes = trace.body.ledgerTransaction.entries.map((e: any) => [e.direction, e.account.code]);
    expect(codes).toContainEqual(['DEBIT', ddaHoldingCode(alphaOrg)]);
    expect(codes).toContainEqual(['CREDIT', ddaHoldingCode(betaOrg)]);
    expect(trace.body.ledgerTransaction.entries.every((e: any) => e.amount.currency === 'DDA')).toBe(true);
    expect(trace.body.audit).toHaveLength(1);
    expect(trace.body.audit[0].action).toBe('dda.transfer');
    expect(trace.body.audit[0].actor.id).toBe(adminUser.id);

    const reserve = await admin.post('/v1/admin/dda/reserve-adjustments', {
      deltaUsd: '10.00',
      note: 'Réserve',
    });
    const reserveTrace = await admin.get(`/v1/admin/dda/trace/${reserve.body.reference}`);
    expect(reserveTrace.status).toBe(200);
    expect(reserveTrace.body.ledgerTransaction).toBeNull();
    expect(reserveTrace.body.audit[0].action).toBe('dda.reserve_adjustment');

    expect((await admin.get('/v1/admin/dda/trace/DDA-2026-ZZZZZZ')).status).toBe(404);
    expect((await admin.get('/v1/admin/dda/trace/not-a-reference')).status).toBe(404);
  });
});
