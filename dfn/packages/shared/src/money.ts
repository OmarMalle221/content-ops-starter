/**
 * Money is always handled as BigInt minor units + ISO 4217 code.
 * Floating point numbers are never used for amounts.
 */
export interface CurrencyDefinition {
  code: string;
  name: string;
  exponent: number;
  symbol: string;
}

export const CURRENCIES: Record<string, CurrencyDefinition> = {
  CAD: { code: 'CAD', name: 'Dollar canadien', exponent: 2, symbol: 'CA$' },
  USD: { code: 'USD', name: 'Dollar américain', exponent: 2, symbol: 'US$' },
  EUR: { code: 'EUR', name: 'Euro', exponent: 2, symbol: '€' },
  XOF: { code: 'XOF', name: 'Franc CFA (BCEAO)', exponent: 0, symbol: 'FCFA' },
  GNF: { code: 'GNF', name: 'Franc guinéen', exponent: 0, symbol: 'FG' },
};

export const SUPPORTED_CURRENCY_CODES = Object.keys(CURRENCIES) as Array<keyof typeof CURRENCIES>;

export function getCurrency(code: string): CurrencyDefinition {
  const def = CURRENCIES[code];
  if (!def) throw new Error(`Unsupported currency: ${code}`);
  return def;
}

export interface Money {
  amountMinor: bigint;
  currencyCode: string;
}

/** Parse a decimal string such as "1250.50" into minor units, strictly. */
export function parseDecimalToMinor(input: string | number, currencyCode: string): bigint {
  const { exponent } = getCurrency(currencyCode);
  const str = String(input).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error(`Invalid amount: ${input}`);
  const [whole, frac = ''] = str.split('.');
  if (frac.length > exponent) throw new Error(`Too many decimals for ${currencyCode}: ${input}`);
  const paddedFrac = frac.padEnd(exponent, '0');
  return BigInt(whole + paddedFrac);
}

/** Convert minor units to a decimal string without any floating point. */
export function minorToDecimalString(amountMinor: bigint | string | number, currencyCode: string): string {
  const { exponent } = getCurrency(currencyCode);
  const value = BigInt(amountMinor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = abs.toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const frac = exponent === 0 ? '' : digits.slice(-exponent);
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function formatMoney(
  amountMinor: bigint | string | number,
  currencyCode: string,
  locale = 'fr-CA',
): string {
  const { exponent } = getCurrency(currencyCode);
  const decimal = minorToDecimalString(amountMinor, currencyCode);
  const num = Number(decimal);
  // Number() is only used for presentation — never for arithmetic.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(num);
}

/** Basis-point fee with half-up rounding, computed in integers. */
export function computeFeeMinor(amountMinor: bigint, feeBps: number): bigint {
  if (feeBps < 0 || !Number.isInteger(feeBps)) throw new Error('feeBps must be a non-negative integer');
  const numerator = amountMinor * BigInt(feeBps);
  const denominator = 10_000n;
  return (numerator + denominator / 2n) / denominator;
}

export function sumMinor(values: Array<bigint | string | number>): bigint {
  return values.reduce<bigint>((acc, v) => acc + BigInt(v), 0n);
}

/** JSON-safe serialisation: BigInt → string. */
export function serializeMinor(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}
