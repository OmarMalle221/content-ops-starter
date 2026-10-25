import { describe, expect, it } from 'vitest';
import { hasResidualIdentifiers, pseudonymize, reidentify } from '../../src/shared/pseudonymize/pseudonymize';
import { DISCHARGE_SUMMARY_PAGES, FICTIONAL_DICTIONARY, FICTIONAL_IDENTIFIERS } from '../support/documents';

const discharge = DISCHARGE_SUMMARY_PAGES.map((page) => page.join('\n')).join('\n\n');
const empty = { persons: [], addresses: [] };

describe('pseudonymisation (règle no 6)', () => {
    it('retire tous les identifiants du résumé de départ fictif', () => {
        const { text } = pseudonymize(discharge, FICTIONAL_DICTIONARY);
        for (const identifier of FICTIONAL_IDENTIFIERS) expect(text).not.toContain(identifier);
        expect(hasResidualIdentifiers(text)).toBe(false);
    });

    it('garde ce qui est utile au résumé : médicaments, dates de suivi, titres, établissements', () => {
        const { text } = pseudonymize(discharge, FICTIONAL_DICTIONARY);
        expect(text).toContain('Metformine 500 mg 2 fois par jour');
        expect(text).toContain('Rendez-vous en gériatrie le 12 novembre 2026 à 10 h 30');
        expect(text).toContain('Date de départ : 3 octobre 2026');
        expect(text).toMatch(/Dre \[PERSONNE_\d+\], gériatre/);
        expect(text).toMatch(/Mme \[PERSONNE_\d+\]/);
        expect(text).toContain('Hôpital Notre-Dame');
        expect(text).toContain('au CLSC dans deux semaines');
    });

    it('remplace chaque catégorie par son jeton', () => {
        const { text, counts } = pseudonymize(discharge, FICTIONAL_DICTIONARY);
        expect(text).toContain('NAM : [NAM_1]');
        expect(text).toContain('No dossier : [NUMERO_DOSSIER_1]');
        expect(text).toContain('Né le [DATE_NAISSANCE_1]');
        expect(text).toContain('Adresse : [ADRESSE_1] (Québec) [CODE_POSTAL_1]');
        expect(text).toContain('Téléphone : [TELEPHONE_1]');
        expect(text).toContain('Courriel : [COURRIEL_1]');
        expect(text).toContain(': [NAS_1]');
        expect(counts).toMatchObject({
            health_card: 1,
            record_number: 1,
            birth_date: 1,
            address: 1,
            postal_code: 1,
            email: 1,
            sin: 1,
            phone: 2
        });
        expect(counts.person).toBeGreaterThanOrEqual(6);
    });

    it('les compteurs ne contiennent aucune valeur', () => {
        const { counts } = pseudonymize(discharge, FICTIONAL_DICTIONARY);
        const serialized = JSON.stringify(counts);
        for (const identifier of FICTIONAL_IDENTIFIERS) expect(serialized).not.toContain(identifier);
    });

    it('reconnaît le NAM sous plusieurs formes', () => {
        for (const nam of ['GAGR 4503 1512', 'GAGR45031512', 'gagr-4503-1512', 'Gagr 4503 1512']) {
            expect(pseudonymize(`Carte : ${nam}.`, empty).text).toBe('Carte : [NAM_1].');
        }
    });

    it('reconnaît téléphones, codes postaux et courriels courants', () => {
        const cases: Array<[string, string]> = [
            ['(514) 555-0142', '[TELEPHONE_1]'],
            ['514.555.0142 poste 221', '[TELEPHONE_1]'],
            ['+1 450 555 0199', '[TELEPHONE_1]'],
            ['h2l1m9', '[CODE_POSTAL_1]'],
            ['G1R 4S9', '[CODE_POSTAL_1]'],
            ['marie.tremblay@exemple.qc.ca', '[COURRIEL_1]']
        ];
        for (const [value, token] of cases) expect(pseudonymize(`Joindre : ${value}`, empty).text).toBe(`Joindre : ${token}`);
    });

    it('trouve les noms du dictionnaire sans tenir compte de la casse ni des accents', () => {
        const { text } = pseudonymize('ROGER GAGNON ; roger ; Gagnon-Tremblay ; Hélène et Helene', {
            persons: ['Roger Gagnon', 'Hélène'],
            addresses: []
        });
        expect(text).not.toMatch(/roger|gagnon|h[ée]l[èe]ne/i);
        expect(text).toContain('-Tremblay');
    });

    it('donne le même jeton à la même valeur', () => {
        const { text } = pseudonymize('Tél. 514 555-0142, rappeler au 514-555-0142.', empty);
        expect(text).toBe('Tél. [TELEPHONE_1], rappeler au [TELEPHONE_1].');
    });

    it('masque un nom inconnu précédé d’un titre ou d’une étiquette', () => {
        expect(pseudonymize('Vu par Dr Jean-Pierre Côté, cardiologue.', empty).text).toBe('Vu par Dr [PERSONNE_1], cardiologue.');
        expect(pseudonymize('Usagère : TREMBLAY, Jeanne', empty).text).toBe('Usagère : [PERSONNE_1]');
        expect(pseudonymize('Signature : Dre Fortin', { persons: ['Fortin'], addresses: [] }).text).toBe('Signature : Dre [PERSONNE_1]');
    });

    it('un nom en fin de ligne n’emporte pas la ligne suivante', () => {
        expect(pseudonymize('Dre Isabelle Fortin\nORDONNANCE RENOUVELÉE', empty).text).toBe('Dre [PERSONNE_1]\nORDONNANCE RENOUVELÉE');
    });

    it('masque une adresse inconnue introduite par un numéro civique', () => {
        expect(pseudonymize('Domicile : 45, avenue des Pins Ouest, app. 3', empty).text).toBe('Domicile : [ADRESSE_1], app. 3');
    });

    it('ne masque pas les doses, quantités ni numéros de chambre', () => {
        const text = 'Ramipril 5 mg 1 fois par jour. 2 côtes fracturées. Chambre 412. 1 place disponible.';
        expect(pseudonymize(text, empty).text).toBe(text);
    });

    it('ré-identifie noms, adresses, téléphones et courriels ; laisse NAM, NAS et dates de naissance masqués', () => {
        const { mapping } = pseudonymize(discharge, FICTIONAL_DICTIONARY);
        const person = [...mapping.entries()].find(([, entry]) => entry.value === 'Isabelle Fortin')?.[0];
        expect(person).toBeDefined();
        const back = reidentify(`Dre ${person}, [ADRESSE_1], [TELEPHONE_1], [NAM_1], [NAS_1], [DATE_NAISSANCE_1], [PERSONNE_99]`, mapping);
        expect(back.text).toBe(
            'Dre Isabelle Fortin, 1200, rue Sherbrooke Est, Montréal, 514 555-0142, [NAM masqué], [NAS masqué], [date de naissance masquée], [renseignement masqué]'
        );
        expect(back.unknownTokens).toBe(1);
    });

    it('tolère un jeton légèrement déformé par le modèle', () => {
        const { mapping } = pseudonymize('Tél. 514 555-0142', empty);
        expect(reidentify('Appeler au TELEPHONE_1 ou [TELEPHONE 1].', mapping).text).toBe('Appeler au 514 555-0142 ou 514 555-0142.');
    });
});
