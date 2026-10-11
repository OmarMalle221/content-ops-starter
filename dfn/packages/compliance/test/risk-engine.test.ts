import { describe, expect, it } from 'vitest';
import {
  RiskEngine,
  analyzeStructuring,
  structuringDedupKey,
  structuringThresholdMinor,
  type RiskFacts,
  type StructuringFacts,
  type StructuringOperation,
  structuringThresholdFor,
  isValidStructuringThresholdSpec,
} from '../src';

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

describe('RiskEngine — STRUCTURING', () => {
  const T0 = Date.parse('2026-10-11T08:00:00.000Z');
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  const op = (
    reference: string,
    amountMinor: bigint,
    minutes: number,
    extra: Partial<StructuringOperation> = {},
  ): StructuringOperation => ({
    kind: 'TRANSFER',
    reference,
    amountMinor,
    occurredAt: at(minutes),
    ...extra,
  });
  const facts = (
    operations: StructuringOperation[],
    overrides: Partial<StructuringFacts> = {},
    subjects?: StructuringFacts['subjects'],
  ): StructuringFacts => ({
    currencyCode: 'CAD',
    flow: 'OUTBOUND',
    windowHours: 24,
    threshold: '10000.00',
    subjects: subjects ?? [{ type: 'ORGANIZATION', id: 'org-1', operations }],
    ...overrides,
  });
  const evaluate = (structuring: StructuringFacts, event: RiskFacts['event'] = 'transfer.authorized') =>
    engine.evaluate({ event, structuring });

  it('parses the nominal threshold with the currency exponent', () => {
    expect(structuringThresholdMinor('10000.00', 'CAD')).toBe(1_000_000n);
    expect(structuringThresholdMinor('10000.00', 'XOF')).toBe(10_000n);
    expect(structuringThresholdMinor('10000,5', 'EUR')).toBe(1_000_050n);
    expect(structuringThresholdMinor('2500', 'GNF')).toBe(2_500n);
    expect(() => structuringThresholdMinor('10000.00', 'ZZZ')).toThrow();
  });

  it('stays silent below the threshold or with a single operation', () => {
    expect(
      evaluate(facts([op('TRF-1', 400_000n, 0), op('TRF-2', 400_000n, 30, { current: true })])).signals,
    ).toHaveLength(0);
    expect(evaluate(facts([op('TRF-1', 999_999n, 0, { current: true })])).signals).toHaveLength(0);
    expect(evaluate(facts([])).signals).toHaveLength(0);
  });

  it('flags two operations reaching the threshold as MEDIUM and three or more as HIGH', () => {
    const two = evaluate(facts([op('TRF-1', 600_000n, 0), op('TRF-2', 400_000n, 30, { current: true })]));
    expect(two.signals.map((s) => s.ruleCode)).toEqual(['STRUCTURING']);
    expect(two.signals[0].severity).toBe('MEDIUM');
    expect(two.recommendation).toBe('MONITOR');

    const three = evaluate(
      facts([
        op('TRF-1', 400_000n, 0),
        op('TRF-2', 400_000n, 30),
        op('TRF-3', 400_000n, 60, { current: true }),
      ]),
    );
    expect(three.signals[0].severity).toBe('HIGH');
    expect(three.highestSeverity).toBe('HIGH');
    expect(three.recommendation).toBe('MANUAL_REVIEW');
  });

  it('ignores operations at or above the threshold and a large triggering operation', () => {
    // 9 999.99 + 10 000.00: only one operation is below the threshold.
    const large = evaluate(facts([op('TRF-1', 999_999n, 0), op('TRF-2', 1_000_000n, 30)]));
    expect(large.signals).toHaveLength(0);
    // The triggering operation is itself above the threshold: not structuring.
    const current = evaluate(
      facts([
        op('TRF-1', 600_000n, 0),
        op('TRF-2', 500_000n, 10),
        op('TRF-3', 2_000_000n, 20, { current: true }),
      ]),
    );
    expect(current.signals).toHaveLength(0);
    // Exactly the threshold in total is enough ("reaches").
    const exact = evaluate(facts([op('TRF-1', 500_000n, 0), op('TRF-2', 500_000n, 10)]));
    expect(exact.signals[0].severity).toBe('MEDIUM');
  });

  it('applies the threshold per currency exponent', () => {
    // 3 × 4 000 XOF = 12 000 XOF ≥ "10000.00" read as 10 000 XOF.
    const xof = evaluate(
      facts([op('DEP-1', 4_000n, 0), op('DEP-2', 4_000n, 5), op('DEP-3', 4_000n, 10, { current: true })], {
        currencyCode: 'XOF',
        flow: 'INBOUND',
      }),
      'wallet.self_deposit',
    );
    expect(xof.signals[0].severity).toBe('HIGH');
    expect(xof.signals[0].explanation.factors.threshold).toBe('10000');
    // The same minor amounts in CAD are 120.00 CAD in total: silent.
    const cad = evaluate(
      facts([op('DEP-1', 4_000n, 0), op('DEP-2', 4_000n, 5), op('DEP-3', 4_000n, 10, { current: true })]),
    );
    expect(cad.signals).toHaveLength(0);
    // Unsupported currency: the rule never guesses.
    expect(evaluate(facts([op('A', 1n, 0), op('B', 1n, 1)], { currencyCode: 'ZZZ' })).signals).toHaveLength(
      0,
    );
  });

  it('explains the pattern: count, sum, window, threshold, references and evidence', () => {
    const r = evaluate(
      facts([
        op('TRF-1', 350_000n, 0),
        op('TRF-2', 350_000n, 45, { kind: 'INVOICE_PAYMENT' }),
        op('TRF-3', 350_000n, 90, { current: true }),
      ]),
    );
    const signal = r.signals[0];
    expect(signal.explanation.summary).toContain('3 operations');
    expect(signal.explanation.summary).toContain('10500.00 CAD');
    expect(signal.explanation.factors).toMatchObject({
      subjectType: 'ORGANIZATION',
      subjectId: 'org-1',
      currencyCode: 'CAD',
      flow: 'OUTBOUND',
      operationsCount: 3,
      sum: '10500.00',
      sumMinor: '1050000',
      threshold: '10000.00',
      thresholdMinor: '1000000',
      windowHours: 24,
      kinds: 'INVOICE_PAYMENT,TRANSFER',
      references: 'TRF-1, TRF-2, TRF-3',
      dedupKey: 'STRUCTURING:OUTBOUND:ORGANIZATION:org-1:CAD',
    });
    expect(signal.explanation.evidence).toHaveLength(3);
    expect(signal.explanation.evidence?.[2]).toMatchObject({
      reference: 'TRF-3',
      amount: '3500.00',
      current: true,
    });
    expect(signal.explanation.recommendation).toMatch(/tipping-off/);
    // JSON-safe: no BigInt anywhere in the explanation.
    expect(() => JSON.stringify(signal.explanation)).not.toThrow();
  });

  it('retains the subject with the most operations and de-duplicates repeated references', () => {
    const r = evaluate(
      facts([], {}, [
        { type: 'ORGANIZATION', id: 'org-1', operations: [op('A', 600_000n, 0), op('B', 500_000n, 5)] },
        {
          type: 'USER',
          id: 'user-1',
          operations: [
            op('A', 600_000n, 0),
            op('B', 500_000n, 5),
            op('C', 100_000n, 9),
            op('C', 100_000n, 9),
          ],
        },
      ]),
    );
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0].explanation.factors.subjectType).toBe('USER');
    expect(r.signals[0].explanation.factors.operationsCount).toBe(3);
    expect(r.signals[0].severity).toBe('HIGH');
  });

  it('only runs on the aggregated money events', () => {
    const structuring = facts([op('A', 600_000n, 0), op('B', 500_000n, 5)]);
    for (const event of [
      'transaction.funded',
      'transfer.authorized',
      'wallet.self_deposit',
      'invoice.wallet_payment',
    ] as const) {
      expect(engine.evaluate({ event, structuring }).signals.map((s) => s.ruleCode)).toEqual(['STRUCTURING']);
    }
    expect(engine.evaluate({ event: 'transfer.created', structuring }).signals).toHaveLength(0);
    expect(engine.evaluate({ event: 'transaction.created', structuring }).signals).toHaveLength(0);
    expect(engine.listRules().map((r) => r.code)).toContain('STRUCTURING');
  });

  it('exposes the analysis and the de-duplication key', () => {
    const analysis = analyzeStructuring(
      facts([op('A', 600_000n, 10), op('B', 500_000n, 5), op('C', 2_000_000n, 1)]),
    );
    expect(analysis.thresholdMinor).toBe(1_000_000n);
    expect(analysis.retained?.operations.map((o) => o.reference)).toEqual(['B', 'A']);
    expect(analysis.retained?.sumMinor).toBe(1_100_000n);
    expect(structuringDedupKey('INBOUND', { type: 'USER', id: 'u' }, 'XOF')).toBe(
      'STRUCTURING:INBOUND:USER:u:XOF',
    );
  });
});

describe('structuring thresholds per currency', () => {
  it('picks the currency entry, else the default, else nothing', () => {
    const spec = '10000.00,XOF:4400000,GNF:63000000';
    expect(structuringThresholdFor(spec, 'XOF')).toBe('4400000');
    expect(structuringThresholdFor(spec, 'gnf')).toBe('63000000');
    expect(structuringThresholdFor(spec, 'CAD')).toBe('10000.00');
    expect(structuringThresholdFor('XOF:4400000', 'CAD')).toBeNull();
    expect(structuringThresholdMinor(structuringThresholdFor(spec, 'XOF')!, 'XOF')).toBe(4_400_000n);
    expect(structuringThresholdMinor(structuringThresholdFor(spec, 'CAD')!, 'CAD')).toBe(1_000_000n);
  });

  it('validates the specification format', () => {
    expect(isValidStructuringThresholdSpec('10000.00')).toBe(true);
    expect(isValidStructuringThresholdSpec('10000.00,XOF:4400000,GNF:63000000')).toBe(true);
    expect(isValidStructuringThresholdSpec('XOF:4400000')).toBe(true);
    expect(isValidStructuringThresholdSpec('10000,20000')).toBe(false);
    expect(isValidStructuringThresholdSpec('xof:10')).toBe(false);
    expect(isValidStructuringThresholdSpec('XOF:')).toBe(false);
    expect(isValidStructuringThresholdSpec('10000.00,,XOF:1')).toBe(false);
    expect(isValidStructuringThresholdSpec('')).toBe(false);
  });
});
