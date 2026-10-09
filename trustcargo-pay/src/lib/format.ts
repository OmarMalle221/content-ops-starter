import { formatMoney, type MoneyDTO } from '@/domain/money';

export function fmtMoney(m: MoneyDTO, intl: string) {
    return formatMoney(m, intl);
}

export function fmtDate(iso: string | undefined, intl: string, withTime = false) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(
        intl,
        withTime ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' } : { dateStyle: 'medium', timeZone: 'UTC' }
    ).format(new Date(iso));
}

export function fmtPct(bps: number, intl: string) {
    return new Intl.NumberFormat(intl, { style: 'percent', maximumFractionDigits: 2 }).format(bps / 10_000);
}

export function fmtBytes(n: number) {
    return n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function shortHash(h: string) {
    return `${h.slice(0, 10)}…${h.slice(-6)}`;
}
