import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpReferenceFxRateProvider,
  PartnerCallError,
  assertPlausibleRate,
  convertMinor,
  parseRateRational,
} from '../src';
import { startMockPartner, type MockHandler, type MockPartner } from './helpers/mock-partner';

const API_KEY = 'ref_fx_key_0123456789';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const FRESH = '2026-10-11T11:59:45.000Z';

let partner: MockPartner | undefined;
afterEach(async () => {
  await partner?.close();
  partner = undefined;
});

async function fx(handler: MockHandler, overrides: Record<string, unknown> = {}) {
  partner = await startMockPartner(handler);
  const provider = new HttpReferenceFxRateProvider({
    baseUrl: partner.baseUrl,
    apiKey: API_KEY,
    timeoutMs: 1_000,
    maxRetries: 1,
    sleep: async () => undefined,
    now: () => NOW,
    ...overrides,
  });
  return { provider, partner };
}

const rateReply =
  (rate: unknown, asOf = FRESH, base = 'CAD', quote = 'XOF'): MockHandler =>
  () => ({ status: 200, body: { base, quote, rate, asOf } });

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PartnerCallError);
  expect((err as PartnerCallError).code).toBe(code);
}

describe('HttpReferenceFxRateProvider — contract', () => {
  it('GETs the pair with the bearer key and applies the spread with integer math', async () => {
    const { provider, partner } = await fx(rateReply('440'));
    const rate = await provider.getRate('CAD', 'XOF');
    expect(partner.requests).toHaveLength(1);
    expect(partner.requests[0].method).toBe('GET');
    expect(partner.requests[0].path).toBe('/v1/rates');
    expect(partner.requests[0].query).toEqual({ base: 'CAD', quote: 'XOF' });
    expect(partner.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(partner.requests[0].headers['idempotency-key']).toBeUndefined();
    expect(rate).toMatchObject({ provider: 'reference', simulated: false, spreadBps: 150 });
    expect(rate.asOf.toISOString()).toBe(FRESH);
    // Same result as the sandbox for the same mid: 100.00 CAD × 440 × (1 − 1.5 %) = 43 340 XOF
    expect(convertMinor(10_000n, rate, 'CAD', 'XOF')).toBe(43_340n);
  });

  it('parses decimal and rational rates exactly (no floating point)', async () => {
    expect(parseRateRational('655.957')).toEqual({ numerator: 655957n, denominator: 1000n });
    expect(parseRateRational('0.001500')).toEqual({ numerator: 3n, denominator: 2000n });
    expect(parseRateRational({ numerator: '1000', denominator: '655957' })).toEqual({
      numerator: 1000n,
      denominator: 655957n,
    });
    const { provider } = await fx(
      rateReply({ numerator: '655957', denominator: '1000' }, FRESH, 'EUR', 'XOF'),
      {
        spreadBps: 0,
      },
    );
    const rate = await provider.getRate('EUR', 'XOF');
    expect(convertMinor(10_000n, rate, 'EUR', 'XOF')).toBe(65_596n);
  });

  it('is the identity for same-currency pairs without calling the partner', async () => {
    const { provider, partner } = await fx(rateReply('1'));
    const rate = await provider.getRate('USD', 'USD');
    expect(rate.numerator).toBe(1n);
    expect(partner.requests).toHaveLength(0);
  });

  it('refuses stale and future-dated rates', async () => {
    const stale = await fx(rateReply('440', '2026-10-11T11:58:59.000Z'));
    await expectCode(stale.provider.getRate('CAD', 'XOF'), 'STALE_RATE');
    await stale.partner.close();
    const future = await fx(rateReply('440', '2026-10-11T12:01:00.000Z'));
    await expectCode(future.provider.getRate('CAD', 'XOF'), 'STALE_RATE');
    await future.partner.close();
    const custom = await fx(rateReply('440', '2026-10-11T11:55:00.000Z'), { maxAgeSeconds: 600 });
    expect((await custom.provider.getRate('CAD', 'XOF')).numerator).toBeGreaterThan(0n);
  });

  it.each([
    ['-440', 'negative'],
    ['0', 'zero'],
    ['0.000', 'zero decimal'],
    [440, 'JSON number'],
    ['4.4e2', 'exponent notation'],
    ['440,5', 'comma decimal'],
    ['NaN', 'not a number'],
    [{ numerator: '1', denominator: '0' }, 'zero denominator'],
    [{ numerator: 440, denominator: 1 }, 'numeric rational'],
    [{ numerator: '-1', denominator: '2' }, 'negative rational'],
    ['99999999999', 'absurdly high'],
    ['0.00000001', 'absurdly low'],
    [null, 'missing'],
  ] as Array<[unknown, string]>)('refuses %o (%s)', async (rate, _why) => {
    const { provider } = await fx(rateReply(rate));
    await expectCode(provider.getRate('CAD', 'XOF'), 'INVALID_RATE');
  });

  it('refuses rates too far from the reference mid-rate', async () => {
    const referenceRates = { 'CAD:XOF': [440n, 1n] as const };
    const off = await fx(rateReply('600'), { referenceRates, maxDeviationBps: 1_000 });
    await expectCode(off.provider.getRate('CAD', 'XOF'), 'INVALID_RATE');
    await off.partner.close();
    const near = await fx(rateReply('470'), { referenceRates, maxDeviationBps: 1_000 });
    expect((await near.provider.getRate('CAD', 'XOF')).numerator).toBe(470n * 9_850n);
    expect(() => assertPlausibleRate({ numerator: 400n, denominator: 1n }, [440n, 1n], 500)).toThrow(
      /deviates/,
    );
  });

  it('refuses a response for another pair, malformed dates and unsupported currencies', async () => {
    const wrongPair = await fx(rateReply('440', FRESH, 'CAD', 'GNF'));
    await expectCode(wrongPair.provider.getRate('CAD', 'XOF'), 'BAD_RESPONSE');
    await wrongPair.partner.close();
    const badDate = await fx(rateReply('440', 'yesterday'));
    await expectCode(badDate.provider.getRate('CAD', 'XOF'), 'BAD_RESPONSE');
    await expect(badDate.provider.getRate('CAD', 'ZZZ')).rejects.toThrow(/Unsupported currency/);
  });

  it('retries 5xx / timeouts on GET and maps auth errors', async () => {
    const flaky = await fx((req, i) => (i === 0 ? { status: 502, body: {} } : rateReply('440')(req, i)));
    expect((await flaky.provider.getRate('CAD', 'XOF')).simulated).toBe(false);
    expect(flaky.partner.requests).toHaveLength(2);
    await flaky.partner.close();
    const slow = await fx(() => ({ status: 200, body: {}, delayMs: 300 }), { timeoutMs: 40 });
    await expectCode(slow.provider.getRate('CAD', 'XOF'), 'TIMEOUT');
    expect(slow.partner.requests).toHaveLength(2);
    await slow.partner.close();
    const denied = await fx(() => ({ status: 401, body: {} }));
    await expectCode(denied.provider.getRate('CAD', 'XOF'), 'AUTH_FAILED');
    expect(denied.partner.requests).toHaveLength(1);
  });

  it('validates the spread', () => {
    expect(
      () =>
        new HttpReferenceFxRateProvider({
          baseUrl: 'https://fx.example.com',
          apiKey: API_KEY,
          spreadBps: -1,
        }),
    ).toThrow(/spreadBps/);
  });
});
