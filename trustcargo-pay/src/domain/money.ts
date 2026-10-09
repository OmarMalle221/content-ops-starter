/**
 * Deterministic money arithmetic.
 *
 * Amounts are always stored as integer minor units (bigint). Floating point numbers are never
 * used for financial computation. Conversion from user input goes through `parseMoney`, which
 * rejects any precision the currency does not support.
 */

export const CURRENCIES = {
    CAD: { code: 'CAD', minorUnits: 2, name: { fr: 'Dollar canadien', en: 'Canadian dollar' } },
    USD: { code: 'USD', minorUnits: 2, name: { fr: 'Dollar américain', en: 'US dollar' } },
    EUR: { code: 'EUR', minorUnits: 2, name: { fr: 'Euro', en: 'Euro' } },
    XOF: { code: 'XOF', minorUnits: 0, name: { fr: 'Franc CFA (BCEAO)', en: 'West African CFA franc' } }
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export interface Money {
    readonly amountMinor: bigint;
    readonly currency: CurrencyCode;
}

/** Serializable representation (bigint is not JSON / RSC serializable). */
export interface MoneyDTO {
    amountMinor: string;
    currency: CurrencyCode;
}

export class MoneyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MoneyError';
    }
}

export function isCurrencyCode(value: string): value is CurrencyCode {
    return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function minorUnitsOf(currency: CurrencyCode): number {
    return CURRENCIES[currency].minorUnits;
}

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
    return Object.freeze({ amountMinor, currency });
}

export function zero(currency: CurrencyCode): Money {
    return money(0n, currency);
}

/**
 * Parses a decimal string ("18500", "18 500,00", "18500.5") into minor units.
 * Accepts either "." or "," as decimal separator and ignores spaces / thin spaces used as group separators.
 * Rejects more fractional digits than the currency supports (no silent rounding).
 */
export function parseMoney(input: string, currency: CurrencyCode): Money {
    const cleaned = input.trim().replace(/[\s  ']/g, '');
    if (!/^\d+([.,]\d+)?$/.test(cleaned)) {
        throw new MoneyError(`Invalid amount: "${input}"`);
    }
    const [intPart, fracPart = ''] = cleaned.split(/[.,]/) as [string, string?];
    const digits = minorUnitsOf(currency);
    if (fracPart.length > digits) {
        throw new MoneyError(`${currency} supports at most ${digits} decimal digit(s)`);
    }
    const scaled = BigInt(intPart) * 10n ** BigInt(digits) + (fracPart ? BigInt(fracPart.padEnd(digits, '0')) : 0n);
    return money(scaled, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
    if (a.currency !== b.currency) {
        throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
    }
}

export function add(a: Money, b: Money): Money {
    assertSameCurrency(a, b);
    return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
    assertSameCurrency(a, b);
    return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
    return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function equals(a: Money, b: Money): boolean {
    return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
    assertSameCurrency(a, b);
    return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}

export function isPositive(m: Money): boolean {
    return m.amountMinor > 0n;
}

/** 100% expressed in basis points. */
export const FULL_BPS = 10_000;

/**
 * Splits `total` according to basis-point shares using the largest-remainder method.
 * The result always sums exactly to `total`; ties on remainders go to the earliest share.
 */
export function allocateByBps(total: Money, sharesBps: readonly number[]): Money[] {
    const totalBps = sharesBps.reduce((a, b) => a + b, 0);
    if (sharesBps.some((s) => !Number.isInteger(s) || s < 0)) {
        throw new MoneyError('Shares must be non-negative integers (basis points)');
    }
    if (totalBps !== FULL_BPS) {
        throw new MoneyError(`Shares must sum to ${FULL_BPS} bps, got ${totalBps}`);
    }
    if (total.amountMinor < 0n) {
        throw new MoneyError('Cannot allocate a negative amount');
    }
    const denominator = BigInt(FULL_BPS);
    const base = sharesBps.map((s) => (total.amountMinor * BigInt(s)) / denominator);
    const remainders = sharesBps.map((s, i) => ({ i, r: (total.amountMinor * BigInt(s)) % denominator }));
    let leftover = total.amountMinor - base.reduce((a, b) => a + b, 0n);
    remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
    for (const { i } of remainders) {
        if (leftover === 0n) break;
        base[i] = (base[i] ?? 0n) + 1n;
        leftover -= 1n;
    }
    return base.map((amount) => money(amount, total.currency));
}

/** Converts minor units into a plain decimal string ("18500.00"), without locale formatting. */
export function toDecimalString(m: Money): string {
    const digits = minorUnitsOf(m.currency);
    const negative = m.amountMinor < 0n;
    const abs = negative ? -m.amountMinor : m.amountMinor;
    if (digits === 0) return `${negative ? '-' : ''}${abs.toString()}`;
    const s = abs.toString().padStart(digits + 1, '0');
    return `${negative ? '-' : ''}${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** Locale-aware display. Intl.NumberFormat accepts decimal strings, so no float conversion happens. */
export function formatMoney(m: Money | MoneyDTO, locale: string = 'fr-CA'): string {
    const value = 'amountMinor' in m && typeof m.amountMinor === 'string' ? fromDTO(m as MoneyDTO) : (m as Money);
    const digits = minorUnitsOf(value.currency);
    const formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: value.currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
    // `format` accepts a numeric string (Intl.NumberFormat v3) and keeps full precision.
    return formatter.format(toDecimalString(value) as unknown as number);
}

export function toDTO(m: Money): MoneyDTO {
    return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}

export function fromDTO(dto: MoneyDTO): Money {
    if (!/^-?\d+$/.test(dto.amountMinor)) throw new MoneyError('Invalid minor amount');
    return money(BigInt(dto.amountMinor), dto.currency);
}

export function formatBps(bps: number, locale: string = 'fr-CA'): string {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bps / FULL_BPS);
}
