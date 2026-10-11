import { describe, expect, it } from 'vitest';
import { SandboxFxRateProvider, convertMinor, createFxRateProvider, quoteTransferFee } from '../src';

describe('Sandbox FX provider', () => {
  const fx = new SandboxFxRateProvider(150);

  it('converts with integer math and applies the spread', async () => {
    const rate = await fx.getRate('CAD', 'XOF');
    // 100.00 CAD × 440 × (1 − 1.5 %) = 43 340 XOF
    expect(convertMinor(10_000n, rate, 'CAD', 'XOF')).toBe(43_340n);
    const back = await fx.getRate('XOF', 'CAD');
    expect(convertMinor(43_340n, back, 'XOF', 'CAD')).toBe(9_702n); // 97.02 CAD after two spreads
  });

  it('honours the EUR/XOF fixed peg', async () => {
    const rate = new SandboxFxRateProvider(0).getRate('EUR', 'XOF');
    expect(convertMinor(10_000n, await rate, 'EUR', 'XOF')).toBe(65_596n);
  });

  it('is identity for same-currency', async () => {
    const rate = await fx.getRate('USD', 'USD');
    expect(convertMinor(1234n, rate, 'USD', 'USD')).toBe(1234n);
  });

  it('refuses unknown pairs and providers', async () => {
    await expect(fx.getRate('CAD', 'ZZZ')).rejects.toThrow();
    expect(() => createFxRateProvider('bloomberg')).toThrow(/sandbox-only/);
  });

  it('quotes fees as fixed + bps', () => {
    const fee = quoteTransferFee(100_000n, 'CAD');
    expect(fee.fixedFeeMinor).toBe(299n);
    expect(fee.feeMinor).toBe(299n + 750n);
  });
});
