import { minorToDecimalString } from '@dfn/shared';
import type { Locale } from './i18n';

export interface MoneyDto {
  minor: string;
  decimal: string;
  currency: string;
}

const EXPONENT: Record<string, number> = { CAD: 2, USD: 2, EUR: 2, XOF: 0, GNF: 0 };
const SYMBOL: Record<string, string> = { CAD: '$', USD: 'US$', EUR: '€', XOF: 'FCFA', GNF: 'FG' };
const NBSP = '\u00a0';

function groupThousands(integer: string, separator: string) {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** MoneyDto of an amount the API sends as bare minor units (admin statistics, ledger balances). */
export function moneyFromMinor(minor: string | bigint, currency: string): MoneyDto {
  return { minor: String(minor), decimal: minorToDecimalString(minor, currency), currency };
}

/**
 * Deterministic money formatting (no Intl): the same string is produced by Node and by every
 * browser engine, which keeps server rendering and client hydration identical.
 */
export function formatMoney(m: MoneyDto | null | undefined, locale: Locale = 'fr'): string {
  if (!m) return '—';
  const exponent = EXPONENT[m.currency] ?? 2;
  const negative = m.decimal.startsWith('-');
  const [intPart, fracPart = ''] = m.decimal.replace('-', '').split('.');
  const frac = exponent > 0 ? fracPart.padEnd(exponent, '0').slice(0, exponent) : '';
  const symbol = SYMBOL[m.currency] ?? m.currency;
  const sign = negative ? '-' : '';
  if (locale === 'fr') {
    const grouped = groupThousands(intPart, NBSP);
    return `${sign}${grouped}${frac ? ',' + frac : ''}${NBSP}${symbol}`;
  }
  const grouped = groupThousands(intPart, ',');
  return `${sign}${symbol}${grouped}${frac ? '.' + frac : ''}`;
}

const MONTHS: Record<Locale, string[]> = {
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/** Deterministic date formatting in UTC (sandbox convention: all timestamps are UTC). */
export function formatDate(
  d: string | Date | null | undefined,
  locale: Locale = 'fr',
  withTime = false,
): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  const day = date.getUTCDate();
  const month = MONTHS[locale][date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const base = locale === 'fr' ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`;
  if (!withTime) return base;
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${base} ${hh}:${mm} UTC`;
}

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'outline'
  | 'sandbox'
  | 'muted';

export function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'SETTLED':
    case 'RELEASED':
    case 'SIMULATED_PASS':
    case 'CONFIRMED':
    case 'ACCEPTED':
    case 'ACTIVE':
    case 'CLOSED':
    case 'PAID':
    case 'CONVERTED':
    case 'DELIVERED':
    case 'COMPLETED':
    case 'POSTED':
    case 'DEPOSIT':
    case 'RELEASE':
    case 'APPROVED':
      return 'success';
    case 'DISPUTED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
    case 'REJECTED':
    case 'SIMULATED_FAIL':
    case 'SUSPENDED':
    case 'DEACTIVATED':
    case 'DECLINED':
    case 'OVERDUE':
    case 'EXHAUSTED':
    case 'REVERSED':
    case 'VOID':
    case 'HIGH':
      return 'destructive';
    case 'PENDING_ACCEPTANCE':
    case 'AWAITING_FUNDING':
    case 'SUBMITTED':
    case 'CHANGES_REQUESTED':
    case 'OPEN':
    case 'UNDER_REVIEW':
    case 'APPEALED':
    case 'PENDING':
    case 'PENDING_REVIEW':
    case 'REVIEWING':
    case 'REVIEW_REQUIRED':
    case 'PROCESSING':
    case 'PARTIALLY_PAID':
    case 'RUNNING':
    case 'SENT':
    case 'QUOTED':
    case 'MEDIUM':
      return 'warning';
    case 'FUNDED':
    case 'IN_PROGRESS':
    case 'DECIDED':
    case 'AUTHORIZED':
    case 'CREATED':
    case 'FUNDING':
    case 'REFUND':
    case 'MINTED':
    case 'TRANSFERRED':
    case 'REDEEMED':
    case 'REFUNDED':
      return 'default';
    default:
      return 'muted';
  }
}

export function initials(first?: string, last?: string) {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || '?';
}
