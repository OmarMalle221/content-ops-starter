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
