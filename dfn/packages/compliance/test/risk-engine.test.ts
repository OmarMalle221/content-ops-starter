import { describe, expect, it } from 'vitest';
import { RiskEngine } from '../src';

const engine = new RiskEngine();

describe('RiskEngine', () => {
  it('produces no signals for a routine transaction', () => {
    const r = engine.evaluate({
      event: 'transaction.created',
      amountMinor: 250_000n,
      currencyCode: 'CAD',
      averageAmountMinor: 300_000n,
      transactionsLast24h: 1,
      identityVerified: true,
      userCountry: 'CA',
      originCountry: 'CA',
      corridorSupported: true,
      accountAgeDays: 120,
    });
    expect(r.signals).toHaveLength(0);
    expect(r.recommendation).toBe('NONE');
  });

  it('flags a high-value unverified transaction with an explanation', () => {
    const r = engine.evaluate({
      event: 'transaction.created',
      amountMinor: 2_000_000n,
      currencyCode: 'CAD',
      identityVerified: false,
      transactionsLast24h: 1,
    });
    const codes = r.signals.map((s) => s.ruleCode);
    expect(codes).toContain('UNVERIFIED_HIGH_VALUE');
    expect(r.recommendation).toBe('MANUAL_REVIEW');
    expect(r.signals[0].explanation.summary.length).toBeGreaterThan(10);
  });

  it('escalates velocity and disputes', () => {
    const r = engine.evaluate({
      event: 'transaction.created',
      transactionsLast24h: 12,
      disputesAsPartyTotal: 5,
    });
    expect(r.signals.map((s) => s.ruleCode).sort()).toEqual(['MULTI_DISPUTE_ACCOUNT', 'VELOCITY_24H']);
    expect(r.highestSeverity).toBe('HIGH');
  });

  it('only runs rules for the matching event', () => {
    const r = engine.evaluate({
      event: 'auth.login_failed',
      failedLoginsLast15m: 6,
      transactionsLast24h: 50,
    });
    expect(r.signals.map((s) => s.ruleCode)).toEqual(['REPEATED_LOGIN_FAILURES']);
  });

  it('caps the score at 100', () => {
    const r = engine.evaluate({
      event: 'transaction.created',
      amountMinor: 50_000_000n,
      currencyCode: 'CAD',
      averageAmountMinor: 100_000n,
      transactionsLast24h: 20,
      identityVerified: false,
      disputesAsPartyTotal: 9,
      accountAgeDays: 0,
      userCountry: 'FR',
      originCountry: 'CA',
      corridorSupported: false,
    });
    expect(r.totalScore).toBe(100);
  });
});

describe('RiskEngine — Diaspora Transfer rules', () => {
  it('stays silent for a routine, verified transfer to a known beneficiary', () => {
    const r = engine.evaluate({
      event: 'transfer.authorized',
      amountMinor: 50_000n,
      currencyCode: 'CAD',
      transfersLast24h: 1,
      transfersAmountLast24hMinor: 50_000n,
      beneficiaryAgeHours: 300,
      walletBalanceMinor: 1_000_000n,
      identityVerified: true,
      destinationCountry: 'SN',
      corridorSupported: true,
    });
    expect(r.signals).toHaveLength(0);
    expect(r.recommendation).toBe('NONE');
  });

  it('escalates transfer velocity (MEDIUM at 5, HIGH at 10)', () => {
    const medium = engine.evaluate({ event: 'transfer.created', transfersLast24h: 5 });
    expect(medium.signals.map((s) => s.ruleCode)).toEqual(['TRANSFER_VELOCITY']);
    expect(medium.signals[0].severity).toBe('MEDIUM');
    const high = engine.evaluate({ event: 'transfer.authorized', transfersLast24h: 10 });
    expect(high.signals[0].severity).toBe('HIGH');
    expect(high.recommendation).toBe('MANUAL_REVIEW');
    expect(engine.evaluate({ event: 'transfer.created', transfersLast24h: 4 }).signals).toHaveLength(0);
  });

  it('flags a high-value transfer to a beneficiary younger than 24 hours', () => {
    const r = engine.evaluate({
      event: 'transfer.created',
      amountMinor: 800_000n, // 8 000 CAD ≥ 50 % of the 15 000 CAD threshold
      currencyCode: 'CAD',
      beneficiaryAgeHours: 2,
    });
    expect(r.signals.map((s) => s.ruleCode)).toEqual(['NEW_BENEFICIARY_HIGH_VALUE']);
    expect(r.signals[0].severity).toBe('MEDIUM');
    expect(r.recommendation).toBe('MONITOR');
    // Old beneficiary or small amount: nothing.
    expect(
      engine.evaluate({
        event: 'transfer.created',
        amountMinor: 800_000n,
        currencyCode: 'CAD',
        beneficiaryAgeHours: 48,
      }).signals,
    ).toHaveLength(0);
    expect(
      engine.evaluate({
        event: 'transfer.created',
        amountMinor: 700_000n,
        currencyCode: 'CAD',
        beneficiaryAgeHours: 1,
      }).signals,
    ).toHaveLength(0);
  });

  it('flags beneficiary churn only on beneficiary.changed', () => {
    const r = engine.evaluate({ event: 'beneficiary.changed', beneficiaryChangesLast24h: 3 });
    expect(r.signals.map((s) => s.ruleCode)).toEqual(['BENEFICIARY_CHURN']);
    expect(r.signals[0].severity).toBe('MEDIUM');
    expect(
      engine.evaluate({ event: 'beneficiary.changed', beneficiaryChangesLast24h: 2 }).signals,
    ).toHaveLength(0);
    expect(engine.evaluate({ event: 'transfer.created', beneficiaryChangesLast24h: 9 }).signals).toHaveLength(
      0,
    );
  });

  it('requires manual review for an unverified high-value transfer authorisation', () => {
    const r = engine.evaluate({
      event: 'transfer.authorized',
      amountMinor: 1_500_000n,
      currencyCode: 'CAD',
      identityVerified: false,
      beneficiaryAgeHours: 100,
    });
    expect(r.signals.map((s) => s.ruleCode)).toEqual(['UNVERIFIED_TRANSFER']);
    expect(r.highestSeverity).toBe('HIGH');
    expect(r.recommendation).toBe('MANUAL_REVIEW');
    // Verified user, or creation event: the rule does not fire.
    expect(
      engine.evaluate({
        event: 'transfer.authorized',
        amountMinor: 1_500_000n,
        currencyCode: 'CAD',
        identityVerified: true,
      }).signals,
    ).toHaveLength(0);
    expect(
      engine.evaluate({
        event: 'transfer.created',
        amountMinor: 1_500_000n,
        currencyCode: 'CAD',
        identityVerified: false,
      }).signals,
    ).toHaveLength(0);
  });

  it('adds a low signal when a transfer drains the wallet', () => {
    const r = engine.evaluate({
      event: 'transfer.authorized',
      amountMinor: 900_000n,
      currencyCode: 'CAD',
      walletBalanceMinor: 1_000_000n,
      identityVerified: true,
    });
    expect(r.signals.map((s) => s.ruleCode)).toEqual(['TRANSFER_DRAINS_WALLET']);
    expect(r.signals[0].severity).toBe('LOW');
    expect(r.recommendation).toBe('MONITOR');
    // 89 % of the balance, or below half the high-value threshold: silent.
    expect(
      engine.evaluate({
        event: 'transfer.authorized',
        amountMinor: 890_000n,
        currencyCode: 'CAD',
        walletBalanceMinor: 1_000_000n,
      }).signals,
    ).toHaveLength(0);
    expect(
      engine.evaluate({
        event: 'transfer.authorized',
        amountMinor: 50_000n,
        currencyCode: 'CAD',
        walletBalanceMinor: 50_000n,
      }).signals,
    ).toHaveLength(0);
  });

  it('lists the new rules', () => {
    const codes = engine.listRules().map((r) => r.code);
    for (const c of [
      'TRANSFER_VELOCITY',
      'NEW_BENEFICIARY_HIGH_VALUE',
      'BENEFICIARY_CHURN',
      'UNVERIFIED_TRANSFER',
      'TRANSFER_DRAINS_WALLET',
    ]) {
      expect(codes).toContain(c);
    }
  });
});
