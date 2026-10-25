// Fichier calendrier produit sur le téléphone : format RFC 5545 et minimisation.
import { describe, expect, it } from 'vitest';
import { buildIcs, escapeText, foldLine, icsFileName } from '../../src/shared/calendar/ics';

const APPOINTMENT = {
    id: 'a1000000-0000-4000-8000-000000000001',
    title: 'Clinique de gériatrie, 2e étage',
    startsAt: '2026-11-02T15:00:00.000Z',
    endsAt: null,
    location: 'Hôpital fictif; aile B'
};

describe('fichier .ics', () => {
    it('structure, dates UTC, durée d’une heure par défaut, rappel 2 h avant', () => {
        const ics = buildIcs(APPOINTMENT, new Date('2026-10-30T12:00:00Z'));
        const lines = ics.split('\r\n');
        expect(lines[0]).toBe('BEGIN:VCALENDAR');
        expect(lines).toContain('VERSION:2.0');
        expect(lines).toContain(`UID:${APPOINTMENT.id}@relais`);
        expect(lines).toContain('DTSTAMP:20261030T120000Z');
        expect(lines).toContain('DTSTART:20261102T150000Z');
        expect(lines).toContain('DTEND:20261102T160000Z');
        expect(lines).toContain('SUMMARY:Clinique de gériatrie\\, 2e étage');
        expect(lines).toContain('LOCATION:Hôpital fictif\\; aile B');
        expect(lines).toContain('TRIGGER:-PT2H');
        expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
        expect(ics).not.toMatch(/[^\r]\n/); // fins de ligne CRLF seulement
    });

    it('n’emporte ni notes ni questions : seuls titre, heure et lieu', () => {
        const ics = buildIcs({ ...APPOINTMENT, endsAt: '2026-11-02T15:30:00.000Z', location: null });
        expect(ics).toContain('DTEND:20261102T153000Z');
        expect(ics).not.toContain('LOCATION');
        expect(
            ics
                .match(/^[A-Z-]+(?=[:;])/gm)
                ?.filter((p) => !['BEGIN', 'END'].includes(p))
                .sort()
        ).toEqual(
            [
                'ACTION',
                'CALSCALE',
                'DESCRIPTION',
                'DTEND',
                'DTSTAMP',
                'DTSTART',
                'METHOD',
                'PRODID',
                'SUMMARY',
                'TRIGGER',
                'UID',
                'VERSION'
            ].sort()
        );
    });

    it('échappement des caractères spéciaux et des sauts de ligne', () => {
        expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    });

    it('lignes coupées à 75 octets sans couper un caractère accentué', () => {
        const line = `SUMMARY:${'é'.repeat(100)}`;
        const folded = foldLine(line);
        const parts = folded.split('\r\n');
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
        expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
        expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
    });

    it('nom du fichier selon la date au Québec', () => {
        expect(icsFileName('2026-11-03T03:30:00Z')).toBe('rendez-vous-2026-11-02.ics');
    });
});
