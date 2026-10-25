// Heures de l'agenda : saisies et affichées à l'heure du Québec, changements d'heure compris.
import { describe, expect, it } from 'vitest';
import { formatDay, formatTime, localDate, localTime, zonedToIso } from '../../src/lib/format';

describe('heures au Québec', () => {
    it('heure normale (hiver) et heure avancée (été)', () => {
        expect(zonedToIso('2026-11-02', '10:00')).toBe('2026-11-02T15:00:00.000Z');
        expect(zonedToIso('2026-07-15', '10:00')).toBe('2026-07-15T14:00:00.000Z');
    });

    it('autour des changements d’heure', () => {
        // 1er novembre 2026, 1 h 30 existe deux fois ; 8 mars 2026, 2 h 30 n'existe pas.
        expect(localTime(zonedToIso('2026-11-01', '01:30'))).toBe('01:30');
        expect(zonedToIso('2026-11-01', '03:00')).toBe('2026-11-01T08:00:00.000Z');
        expect(zonedToIso('2026-03-08', '03:00')).toBe('2026-03-08T07:00:00.000Z');
        expect(zonedToIso('2026-03-07', '23:30')).toBe('2026-03-08T04:30:00.000Z');
    });

    it('aller-retour saisie → affichage', () => {
        const iso = zonedToIso('2026-12-24', '23:45');
        expect(localDate(iso)).toBe('2026-12-24');
        expect(localTime(iso)).toBe('23:45');
        expect(formatTime(iso)).toBe('23 h 45');
        expect(formatDay(iso)).toBe('jeudi 24 décembre');
        expect(formatDay('2026-11-02')).toBe('lundi 2 novembre');
    });
});
