// Bilan de la semaine (seuil, semaine) et avis aux intervenantes (aucun contenu).
import { describe, expect, it } from 'vitest';
import { checkinTotal, isValidAnswers, needsSupport, weekStart } from '../../src/shared/checkin/score';
import { supportNotificationEmail } from '../../src/shared/support/email';

describe('bilan de la semaine', () => {
    it('seuil : total de 12 ou plus, ou une réponse à 5 (table de vérité)', () => {
        const cases: Array<[number, number, number, boolean]> = [
            [1, 1, 1, false],
            [3, 4, 4, false], // 11
            [4, 4, 4, true], // 12
            [4, 4, 3, false], // 11
            [5, 1, 1, true], // une réponse à 5
            [1, 5, 1, true],
            [1, 1, 5, true],
            [4, 4, 5, true]
        ];
        for (const [fatigue, overwhelm, isolation, expected] of cases) {
            expect(needsSupport({ fatigue, overwhelm, isolation }), `${fatigue}/${overwhelm}/${isolation}`).toBe(expected);
        }
        expect(checkinTotal({ fatigue: 2, overwhelm: 3, isolation: 4 })).toBe(9);
    });

    it('réponses complètes, entières, de 1 à 5', () => {
        expect(isValidAnswers({ fatigue: 1, overwhelm: 5, isolation: 3 })).toBe(true);
        expect(isValidAnswers({ fatigue: 1, overwhelm: null, isolation: 3 })).toBe(false);
        expect(isValidAnswers({ fatigue: 0, overwhelm: 2, isolation: 3 })).toBe(false);
        expect(isValidAnswers({ fatigue: 2.5, overwhelm: 2, isolation: 3 })).toBe(false);
    });

    it('semaine : le lundi, au Québec', () => {
        expect(weekStart(new Date('2026-11-04T15:00:00Z'))).toBe('2026-11-02'); // mercredi
        expect(weekStart(new Date('2026-11-02T04:30:00Z'))).toBe('2026-10-26'); // dimanche 23 h 30 au Québec
        expect(weekStart(new Date('2026-11-02T05:30:00Z'))).toBe('2026-11-02'); // lundi 0 h 30
        expect(weekStart(new Date('2026-11-08T23:00:00Z'))).toBe('2026-11-02'); // dimanche
    });
});

describe('avis aux intervenantes', () => {
    it('aucun contenu : seulement l’origine et le lien du tableau', () => {
        const email = supportNotificationEmail('button', 'https://relais.example/');
        expect(email.subject).toBe('Relais : nouvelle demande d’intervenante');
        expect(email.text).toContain('Ouvrir le tableau : https://relais.example/intervenante');
        expect(email.text).toContain('origine : bouton « Parler à une intervenante »');
        expect(email.html).toContain('href="https://relais.example/intervenante"');
    });

    it('écran d’urgence signalé dans l’objet, pour prioriser', () => {
        expect(supportNotificationEmail('distress_screen', 'https://relais.example').subject).toBe(
            'Relais : nouvelle demande (écran d’urgence)'
        );
    });

    it('texte fixe quelle que soit la demande', () => {
        const a = supportNotificationEmail('checkin', 'https://relais.example');
        const b = supportNotificationEmail('checkin', 'https://relais.example');
        expect(a).toEqual(b);
    });
});
