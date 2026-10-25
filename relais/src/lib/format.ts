const dateFormatter = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Toronto' });

/** « 26 octobre 2026 ». Accepte une date ISO (« 2026-10-26 ») ou un horodatage. */
export function formatDate(value: string): string {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
    return dateFormatter.format(date);
}

/** Numéro lisible : « 1 866 277-3553 », « 514 555-0123 » ; les numéros courts (911, 811) restent tels quels. */
export function formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `1 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return phone;
}

/** Valeur d'un lien tel: ou sms: (chiffres et +). */
export function dialable(phone: string): string {
    return phone.replace(/[^\d+]/g, '');
}

// ------------------------------------------------------------------------- heures (agenda, au Québec)
export const TIME_ZONE = 'America/Toronto';

const timeFormatter = new Intl.DateTimeFormat('fr-CA', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
const dayFormatter = new Intl.DateTimeFormat('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TIME_ZONE });
const partsFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
});

/** « 14 h 30 ». */
export function formatTime(value: string): string {
    return timeFormatter.format(new Date(value));
}

/** « lundi 2 novembre ». */
export function formatDay(value: string): string {
    return dayFormatter.format(/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value));
}

function zonedParts(timestamp: number): { date: string; time: string; wallMs: number } {
    const parts = Object.fromEntries(partsFormatter.formatToParts(new Date(timestamp)).map((p) => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}`;
    const wallMs = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second)
    );
    return { date, time, wallMs };
}

/** Jour au Québec (AAAA-MM-JJ) d'un instant, ou d'aujourd'hui. */
export function localDate(value: string | Date = new Date()): string {
    return zonedParts(new Date(value).getTime()).date;
}

/** Heure au Québec (HH:MM) d'un instant. */
export function localTime(value: string): string {
    return zonedParts(new Date(value).getTime()).time;
}

/**
 * Instant (ISO, UTC) d'une date et d'une heure saisies au Québec, changements d'heure compris :
 * « 2026-11-02 » + « 10:00 » → « 2026-11-02T15:00:00.000Z ».
 */
export function zonedToIso(date: string, time: string): string {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const [hh, mm] = time.split(':').map(Number) as [number, number];
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let instant = wall - (zonedParts(wall).wallMs - wall);
    const correction = zonedParts(instant).wallMs - wall;
    if (correction !== 0) instant -= correction;
    return new Date(instant).toISOString();
}
