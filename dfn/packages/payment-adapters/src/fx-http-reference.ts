import { getCurrency } from '@dfn/shared';
import type { FxRate, FxRateProvider } from './fx';
import {
  PartnerCallError,
  ReferenceHttpClient,
  asObject,
  requireString,
  type ReferenceHttpOptions,
} from './reference-http';

/**
 * HTTP REFERENCE FX rate provider (generic contract, docs/architecture/PARTNER_ADAPTERS.md).
 *
 * Contract tests only: createFxRateProvider never returns it and no environment variable selects
 * it. It shows what a real rate feed must satisfy before it could ever price a transfer:
 *  - rates travel as STRINGS (decimal "655.957" or integer rational {numerator, denominator})
 *    and are parsed into bigint rationals — JSON numbers are refused (binary floating point);
 *  - zero, negative, malformed, absurd (outside [1e-7, 1e7]) and off-reference rates are refused;
 *  - a rate older than `maxAgeSeconds` (or dated in the future beyond the allowed skew) is refused;
 *  - the response must echo the requested pair.
 * The platform spread is applied exactly like the sandbox provider: rate × (1 − spreadBps).
 */

export const REFERENCE_FX_PROVIDER_CODE = 'reference';

export interface HttpReferenceFxOptions extends ReferenceHttpOptions {
  /** Spread applied against the customer. Default 150 bps (same as the sandbox). */
  spreadBps?: number;
  /** Maximum age of a quoted mid-rate. Default 60 s. */
  maxAgeSeconds?: number;
  /** Tolerated clock skew for rates dated in the future. Default 30 s. */
  maxFutureSkewSeconds?: number;
  /**
   * Optional reference mid-rates ("CAD:XOF" → [numerator, denominator]); a quoted rate deviating
   * from its reference by more than `maxDeviationBps` is refused.
   */
  referenceRates?: Readonly<Record<string, readonly [bigint, bigint]>>;
  /** Default 2 000 bps (20 %). */
  maxDeviationBps?: number;
  now?: () => Date;
}

export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

/** Absolute sanity bounds of a major-unit rate: 1e-7 < rate < 1e7. */
const MIN_RATE: Rational = { numerator: 1n, denominator: 10_000_000n };
const MAX_RATE: Rational = { numerator: 10_000_000n, denominator: 1n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y > 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function reduce(r: Rational): Rational {
  const g = gcd(r.numerator, r.denominator);
  return g > 1n ? { numerator: r.numerator / g, denominator: r.denominator / g } : r;
}

/** a < b on rationals with positive denominators. */
function lessThan(a: Rational, b: Rational): boolean {
  return a.numerator * b.denominator < b.numerator * a.denominator;
}

/**
 * Parses a partner rate into an exact rational. Accepted: a decimal string ("440", "655.957",
 * at most 12 integer and 12 fractional digits) or {numerator, denominator} as digit strings.
 */
export function parseRateRational(value: unknown): Rational {
  if (typeof value === 'number') {
    throw new PartnerCallError('INVALID_RATE', 'Rates must be strings, never JSON numbers (float rounding)');
  }
  let r: Rational;
  if (typeof value === 'string') {
    const v = value.trim();
    if (v.startsWith('-')) throw new PartnerCallError('INVALID_RATE', 'Negative rate refused');
    const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(v);
    if (!m) throw new PartnerCallError('INVALID_RATE', 'Malformed decimal rate');
    const frac = m[2] ?? '';
    r = { numerator: BigInt(`${m[1]}${frac}`), denominator: 10n ** BigInt(frac.length) };
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.numerator !== 'string' || typeof o.denominator !== 'string') {
      throw new PartnerCallError('INVALID_RATE', 'Rational rates need string numerator and denominator');
    }
    if (o.numerator.trim().startsWith('-') || o.denominator.trim().startsWith('-')) {
      throw new PartnerCallError('INVALID_RATE', 'Negative rate refused');
    }
    if (!/^\d{1,30}$/.test(o.numerator) || !/^\d{1,30}$/.test(o.denominator)) {
      throw new PartnerCallError('INVALID_RATE', 'Malformed rational rate');
    }
    r = { numerator: BigInt(o.numerator), denominator: BigInt(o.denominator) };
    if (r.denominator === 0n) throw new PartnerCallError('INVALID_RATE', 'Zero denominator');
  } else {
    throw new PartnerCallError('INVALID_RATE', 'Missing rate');
  }
  if (r.numerator === 0n) throw new PartnerCallError('INVALID_RATE', 'Zero rate refused');
  return reduce(r);
}

/** Refuses rates outside the absolute bounds or too far from a reference mid-rate. */
export function assertPlausibleRate(
  rate: Rational,
  reference?: readonly [bigint, bigint],
  maxDeviationBps = 2_000,
): void {
  if (lessThan(rate, MIN_RATE) || lessThan(MAX_RATE, rate)) {
    throw new PartnerCallError('INVALID_RATE', 'Rate outside the plausible range [1e-7, 1e7]');
  }
  if (reference) {
    const [rn, rd] = reference;
    // |rate − ref| / ref > maxDeviation  ⇔  |n·rd − rn·d| · 10 000 > maxDeviationBps · rn · d
    const diff = rate.numerator * rd - rn * rate.denominator;
    const absDiff = diff < 0n ? -diff : diff;
    if (absDiff * 10_000n > BigInt(maxDeviationBps) * rn * rate.denominator) {
      throw new PartnerCallError(
        'INVALID_RATE',
        `Rate deviates from the reference by more than ${maxDeviationBps} bps`,
      );
    }
  }
}

export class HttpReferenceFxRateProvider implements FxRateProvider {
  readonly code = REFERENCE_FX_PROVIDER_CODE;
  readonly simulated = false;
  private readonly http: ReferenceHttpClient;
  private readonly now: () => Date;

  constructor(private readonly options: HttpReferenceFxOptions) {
    const spread = options.spreadBps ?? 150;
    if (!Number.isInteger(spread) || spread < 0 || spread >= 10_000) {
      throw new PartnerCallError('CONFIGURATION', 'spreadBps must be an integer in [0, 10000)');
    }
    this.http = new ReferenceHttpClient(options);
    this.now = options.now ?? (() => new Date());
  }

  /** GET /v1/rates?base=…&quote=… → mid-rate, validated, then the platform spread. */
  async getRate(sourceCurrency: string, destinationCurrency: string): Promise<FxRate> {
    getCurrency(sourceCurrency);
    getCurrency(destinationCurrency);
    const asOfNow = this.now();
    if (sourceCurrency === destinationCurrency) {
      return {
        sourceCurrency,
        destinationCurrency,
        numerator: 1n,
        denominator: 1n,
        spreadBps: 0,
        provider: this.code,
        simulated: false,
        asOf: asOfNow,
      };
    }
    const query = `base=${encodeURIComponent(sourceCurrency)}&quote=${encodeURIComponent(destinationCurrency)}`;
    const body = asObject(await this.http.get(`/v1/rates?${query}`), 'rate');
    if (body.base !== sourceCurrency || body.quote !== destinationCurrency) {
      throw new PartnerCallError('BAD_RESPONSE', 'Rate response does not match the requested pair');
    }
    const asOfRaw = requireString(body, 'asOf', 'rate');
    const asOf = new Date(asOfRaw);
    if (Number.isNaN(asOf.getTime())) throw new PartnerCallError('BAD_RESPONSE', 'Rate asOf is not ISO-8601');
    const ageMs = asOfNow.getTime() - asOf.getTime();
    if (ageMs > (this.options.maxAgeSeconds ?? 60) * 1000) {
      throw new PartnerCallError('STALE_RATE', `Rate is ${Math.round(ageMs / 1000)} s old`);
    }
    if (-ageMs > (this.options.maxFutureSkewSeconds ?? 30) * 1000) {
      throw new PartnerCallError('STALE_RATE', 'Rate is dated in the future');
    }
    const mid = parseRateRational(body.rate);
    assertPlausibleRate(
      mid,
      this.options.referenceRates?.[`${sourceCurrency}:${destinationCurrency}`],
      this.options.maxDeviationBps,
    );
    const spreadBps = this.options.spreadBps ?? 150;
    return {
      sourceCurrency,
      destinationCurrency,
      numerator: mid.numerator * BigInt(10_000 - spreadBps),
      denominator: mid.denominator * 10_000n,
      spreadBps,
      provider: this.code,
      simulated: false,
      asOf,
    };
  }
}
