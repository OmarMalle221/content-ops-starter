// Fichier calendrier (.ics, RFC 5545) d'un rendez-vous, produit sur le téléphone : rien ne passe par un
// serveur. Minimisation : seuls le titre, l'heure et le lieu sont copiés dans le calendrier du téléphone
// (souvent synchronisé ailleurs) ; jamais les notes ni les questions préparées.

export interface IcsAppointment {
    id: string;
    title: string;
    startsAt: string; // ISO 8601
    endsAt: string | null;
    location: string | null;
}

const CRLF = '\r\n';
const MAX_OCTETS = 75;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/** Date UTC au format iCalendar : 20261102T150000Z. */
export function icsDate(date: Date): string {
    return date
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
}

/** Échappement des valeurs texte (virgule, point-virgule, barre oblique inverse, saut de ligne). */
export function escapeText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/** Coupe une ligne à 75 octets UTF-8 sans couper un caractère ; les suites commencent par une espace. */
export function foldLine(line: string): string {
    const encoder = new TextEncoder();
    const parts: string[] = [];
    let current = '';
    let size = 0;
    for (const char of line) {
        const charSize = encoder.encode(char).length;
        const limit = parts.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
        if (size + charSize > limit) {
            parts.push(current);
            current = '';
            size = 0;
        }
        current += char;
        size += charSize;
    }
    parts.push(current);
    return parts.join(`${CRLF} `);
}

export function buildIcs(appointment: IcsAppointment, now: Date = new Date()): string {
    const start = new Date(appointment.startsAt);
    const end = appointment.endsAt ? new Date(appointment.endsAt) : new Date(start.getTime() + DEFAULT_DURATION_MS);
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Relais//Rendez-vous//FR',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${appointment.id}@relais`,
        `DTSTAMP:${icsDate(now)}`,
        `DTSTART:${icsDate(start)}`,
        `DTEND:${icsDate(end)}`,
        `SUMMARY:${escapeText(appointment.title.trim())}`,
        ...(appointment.location?.trim() ? [`LOCATION:${escapeText(appointment.location.trim())}`] : []),
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT2H',
        `DESCRIPTION:${escapeText(appointment.title.trim())}`,
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR'
    ];
    return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Nom du fichier : « rendez-vous-2026-11-02.ics » (date locale du rendez-vous). */
export function icsFileName(startsAt: string, timeZone = 'America/Toronto'): string {
    const day = new Date(startsAt).toLocaleDateString('en-CA', { timeZone });
    return `rendez-vous-${day}.ics`;
}
