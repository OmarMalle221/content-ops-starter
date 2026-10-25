import { describe, expect, it } from 'vitest';
import programsJson from '../../src/content/programs.fr.json';
import { fillPlaceholders, ficheFromProgram, guardExplanation, guardLetter, UNKNOWN_PLACEHOLDER } from '../../src/shared/benefits/ai';
import { criteriaSchema } from '../../src/shared/benefits/engine';
import { simulateExplanation, simulateLetter } from '../support/simulated-llm';

const raw = programsJson.find((p) => p.slug === 'credit-personne-aidante')!;
const fiche = ficheFromProgram({ ...raw, criteria: criteriaSchema.parse(raw.criteria) });
const explanation = (plain: string, extra: Partial<Parameters<typeof guardExplanation>[0]> = {}) => ({
    plain_explanation: plain,
    who_it_may_help: [],
    steps: [],
    not_in_fiche: [],
    ...extra
});

describe('explication d’un programme : rien d’autre que la fiche (règle no 3)', () => {
    it('accepte une explication fidèle, y compris les chiffres de la fiche (365 jours, 70 ans, TP-752.0.14)', () => {
        const result = guardExplanation(
            explanation('Ce crédit aide la personne qui soutient un proche de 70 ans ou plus, ou un adulte avec une déficience.', {
                steps: ['Remplir l’annexe H et joindre le formulaire TP-752.0.14.'],
                not_in_fiche: ['La fiche ne précise pas le montant.']
            }),
            fiche
        );
        expect(result.ok).toBe(true);
    });

    it('refuse un montant, un taux ou un pourcentage', () => {
        for (const text of [
            'Jusqu’à 1 494 $ par année.',
            'Un crédit de 39 % des dépenses.',
            'Quelques centaines de dollars.',
            'Un taux avantageux.'
        ]) {
            expect(guardExplanation(explanation(text), fiche)).toEqual({ ok: false, reason: 'amount' });
        }
    });

    it('refuse un chiffre que la fiche ne contient pas (âge, délai, critère inventés)', () => {
        expect(guardExplanation(explanation('Il faut avoir 65 ans.'), fiche)).toEqual({ ok: false, reason: 'invented_number' });
        expect(guardExplanation(explanation('Réponse en 30 jours.', {}), fiche)).toEqual({ ok: false, reason: 'invented_number' });
        expect(guardExplanation(explanation('Bien.', { steps: ['Appelez le 1 800 555-0000.'] }), fiche)).toMatchObject({ ok: false });
    });

    it('refuse une explication vide ou démesurée', () => {
        expect(guardExplanation(explanation('  '), fiche)).toEqual({ ok: false, reason: 'empty' });
        expect(guardExplanation(explanation('Aide. '.repeat(200)), fiche)).toEqual({ ok: false, reason: 'too_long' });
    });

    it('l’explication simulée d’une fiche passe ; avec un montant inventé, elle est refusée', () => {
        expect(guardExplanation(simulateExplanation(fiche), fiche).ok).toBe(true);
        const trap = { ...fiche, summary: `${fiche.summary} TEST-INVENTION` };
        expect(guardExplanation(simulateExplanation(trap), trap)).toEqual({ ok: false, reason: 'amount' });
    });
});

describe('modèle de lettre à espaces réservés', () => {
    it('garde les espaces réservés prévus et remplace les autres par « [À COMPLÉTER] »', () => {
        const result = guardLetter({ letter: 'Bonjour,\n[NOM DE LA PERSONNE AIDÉE] [NAM DU PATIENT]\n[VOTRE NOM]' }, fiche);
        expect(result).toEqual({ ok: true, letter: `Bonjour,\n[NOM DE LA PERSONNE AIDÉE] ${UNKNOWN_PLACEHOLDER}\n[VOTRE NOM]` });
    });

    it('refuse une lettre avec un montant ou un numéro inventé', () => {
        expect(guardLetter({ letter: 'Je demande les 1 494 $ prévus.' }, fiche)).toEqual({ ok: false, reason: 'amount' });
        expect(guardLetter({ letter: 'Mon numéro : 514 555-0142.' }, fiche)).toEqual({ ok: false, reason: 'invented_number' });
    });

    it('la lettre simulée passe les garde-fous et se remplit sur le téléphone', () => {
        const guarded = guardLetter(simulateLetter(fiche, 'information_request'), fiche);
        expect(guarded.ok).toBe(true);
        const filled = fillPlaceholders(guarded.ok ? guarded.letter : '', {
            '[NOM DE LA PERSONNE AIDÉE]': 'Louise Tremblay',
            '[VOTRE NOM]': 'Claire',
            '[DATE]': '28 octobre 2026'
        });
        expect(filled).toContain('au nom de Louise Tremblay');
        expect(filled).toContain('[VOTRE TÉLÉPHONE]'); // reste à compléter par la personne
        expect(filled.startsWith('28 octobre 2026')).toBe(true);
    });
});
