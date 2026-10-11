import { getCurrency } from '@dfn/shared';

/**
 * FX rate provider contract. Rates are rational numbers (numerator/denominator) so every
 * conversion is computed with integer arithmetic. The sandbox provider serves fixed
 * indicative mid-rates with a spread; it is NOT a market feed.
 */
export interface FxRate {
  sourceCurrency: string;
  destinationCurrency: string;
  /** destination minor units per 1 unit of source, expressed as numerator/denominator on major units. */
  numerator: bigint;
  denominator: bigint;
  spreadBps: number;
  provider: string;
  simulated: boolean;
  asOf: Date;
}

export interface FxRateProvider {
  readonly code: string;
  readonly simulated: boolean;
  getRate(sourceCurrency: string, destinationCurrency: string): Promise<FxRate>;
}

/** Indicative mid-rates (major unit of source → major units of destination) as rationals. */
const MID_RATES: Record<string, [bigint, bigint]> = {
  'CAD:USD': [73n, 100n],
  'CAD:EUR': [67n, 100n],
  'CAD:XOF': [440n, 1n],
  'CAD:GNF': [6300n, 1n],
  'USD:CAD': [137n, 100n],
  'USD:EUR': [92n, 100n],
  'USD:XOF': [600n, 1n],
  'USD:GNF': [8600n, 1n],
  'EUR:CAD': [149n, 100n],
  'EUR:USD': [109n, 100n],
  'EUR:XOF': [655957n, 1000n], // fixed peg
  'EUR:GNF': [9400n, 1n],
  'XOF:CAD': [1n, 440n],
  'XOF:USD': [1n, 600n],
  'XOF:EUR': [1000n, 655957n],
  'XOF:GNF': [143n, 10n],
  'GNF:CAD': [1n, 6300n],
  'GNF:USD': [1n, 8600n],
  'GNF:EUR': [1n, 9400n],
  'GNF:XOF': [10n, 143n],
};

export class SandboxFxRateProvider implements FxRateProvider {
  readonly code = 'sandbox';
  readonly simulated = true;
  constructor(private readonly spreadBps = 150) {}

  async getRate(sourceCurrency: string, destinationCurrency: string): Promise<FxRate> {
    if (sourceCurrency === destinationCurrency) {
      return {
        sourceCurrency,
        destinationCurrency,
        numerator: 1n,
        denominator: 1n,
        spreadBps: 0,
        provider: this.code,
        simulated: true,
        asOf: new Date(),
      };
    }
    const mid = MID_RATES[`${sourceCurrency}:${destinationCurrency}`];
    if (!mid) throw new Error(`No sandbox rate for ${sourceCurrency}→${destinationCurrency}`);
    // Apply the spread against the customer: rate × (1 − spread)
    const numerator = mid[0] * BigInt(10_000 - this.spreadBps);
    const denominator = mid[1] * 10_000n;
    return {
      sourceCurrency,
      destinationCurrency,
      numerator,
      denominator,
      spreadBps: this.spreadBps,
      provider: this.code,
      simulated: true,
      asOf: new Date(),
    };
  }
}

/** Convert source minor units to destination minor units with half-up rounding (integer math). */
export function convertMinor(
  sourceAmountMinor: bigint,
  rate: Pick<FxRate, 'numerator' | 'denominator'>,
  sourceCurrency: string,
  destinationCurrency: string,
): bigint {
  const srcExp = BigInt(getCurrency(sourceCurrency).exponent);
  const dstExp = BigInt(getCurrency(destinationCurrency).exponent);
  // amountMajor = minor / 10^srcExp ; dest = amountMajor × rate × 10^dstExp
  const numerator = sourceAmountMinor * rate.numerator * 10n ** dstExp;
  const denominator = rate.denominator * 10n ** srcExp;
  return (numerator + denominator / 2n) / denominator;
}

/** Sandbox fee schedule for transfers: fixed component (in source currency) + basis points. */
export interface TransferFee {
  feeBps: number;
  fixedFeeMinor: bigint;
  feeMinor: bigint;
}

const FIXED_FEE_MINOR: Record<string, bigint> = { CAD: 299n, USD: 299n, EUR: 249n, XOF: 1500n, GNF: 25000n };

export function quoteTransferFee(
  sourceAmountMinor: bigint,
  sourceCurrency: string,
  feeBps = 75,
): TransferFee {
  const fixedFeeMinor = FIXED_FEE_MINOR[sourceCurrency] ?? 0n;
  const variable = (sourceAmountMinor * BigInt(feeBps) + 5_000n) / 10_000n;
  return { feeBps, fixedFeeMinor, feeMinor: fixedFeeMinor + variable };
}

export function createFxRateProvider(code: string | undefined): FxRateProvider {
  switch ((code ?? 'sandbox').toLowerCase()) {
    case 'sandbox':
      return new SandboxFxRateProvider();
    default:
      throw new Error(`FX provider "${code}" is not available. This build is sandbox-only.`);
  }
}
