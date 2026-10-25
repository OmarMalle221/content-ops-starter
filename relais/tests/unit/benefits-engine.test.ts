import { describe, expect, it } from 'vitest';
import programsJson from '../../src/content/programs.fr.json';
import {
    assess,
    assessPrograms,
    criteriaLabels,
    criteriaSchema,
    factsFromAnswers,
    FACTS,
    type Criteria,
    type Facts,
    type MatchLevel
} from '../../src/shared/benefits/engine';
import { FAMILY_A, FAMILY_B } from '../support/families';

const programs = programsJson.map((p, i) => ({ ...p, id: `p${i}`, criteria: criteriaSchema.parse(p.criteria) }));
const levels = (facts: Facts): Record<string, MatchLevel> =>
    Object.fromEntries(assessPrograms(programs, facts).map((r) => [r.program.slug, r.assessment.level]));

const cond = (fact: (typeof FACTS)[number], op: string, value: unknown) => ({ fact, op, value, label: `${fact} ${op}` }) as never;

describe('moteur de règles : opérateurs et logique à trois valeurs', () => {
    it('compare nombres, booléens et listes', () => {
        const table: Array<[Criteria, Facts, MatchLevel]> = [
            [{ all: [cond('recipient_age', '>=', 70)] }, { recipient_age: 70 }, 'likely'],
            [{ all: [cond('recipient_age', '>=', 70)] }, { recipient_age: 69 }, 'unlikely'],
            [{ all: [cond('recipient_age', '>', 70)] }, { recipient_age: 70 }, 'unlikely'],
            [{ all: [cond('recipient_age', '<', 70)] }, { recipient_age: 69 }, 'likely'],
            [{ all: [cond('recipient_age', '<=', 70)] }, { recipient_age: 71 }, 'unlikely'],
            [{ all: [cond('caregiver_cohabits', '==', true)] }, { caregiver_cohabits: true }, 'likely'],
            [{ all: [cond('caregiver_cohabits', '!=', true)] }, { caregiver_cohabits: true }, 'unlikely'],
            [{ all: [cond('living_setting', 'in', ['home', 'rpa'])] }, { living_setting: 'rpa' }, 'likely'],
            [{ all: [cond('living_setting', 'in', ['home', 'rpa'])] }, { living_setting: 'chsld' }, 'unlikely'],
            [{ all: [cond('living_setting', 'not_in', ['chsld'])] }, { living_setting: 'home' }, 'likely'],
            // Type inattendu : inconnu plutôt qu'une fausse réponse.
            [{ all: [cond('recipient_age', '>=', 70)] }, { recipient_age: '82' as never }, 'possible']
        ];
        for (const [criteria, facts, expected] of table) expect(assess(criteria, facts).level).toBe(expected);
    });

    it('« tous » et « au moins un » suivent les tables de vérité à trois valeurs', () => {
        const met = cond('is_caregiver', '==', true);
        const notMet = cond('caregiver_cohabits', '==', true);
        const unknown = cond('domestic_help', '==', true);
        const facts: Facts = { is_caregiver: true, caregiver_cohabits: false, domestic_help: null };
        const table: Array<[Criteria, MatchLevel]> = [
            [{ all: [met, met] }, 'likely'],
            [{ all: [met, unknown] }, 'possible'],
            [{ all: [unknown, notMet] }, 'unlikely'],
            [{ all: [] }, 'likely'],
            [{ any: [notMet, met] }, 'likely'],
            [{ any: [notMet, unknown] }, 'possible'],
            [{ any: [notMet, notMet] }, 'unlikely'],
            [{ any: [unknown, { all: [met, met] }] }, 'likely'],
            [{ all: [met, { any: [notMet, unknown] }] }, 'possible']
        ];
        for (const [criteria, expected] of table) expect(assess(criteria, facts).level).toBe(expected);
    });

    it('donne une raison par critère, avec le libellé écrit dans la fiche', () => {
        const result = assess(
            { all: [cond('recipient_age', '>=', 70), cond('domestic_help', '==', true)] },
            { recipient_age: 75, domestic_help: null }
        );
        expect(result.reasons).toEqual([
            { label: 'recipient_age >=', status: 'met' },
            { label: 'domestic_help ==', status: 'unknown' }
        ]);
    });

    it('« je ne sais pas » rend un fait inconnu ; la personne qui répond aide un proche', () => {
        expect(factsFromAnswers({ ...FAMILY_A, caregiver_cohabits: 'unknown' })).toMatchObject({
            caregiver_cohabits: null,
            pays_home_support_services: true,
            needs_home_adaptation: true,
            is_caregiver: true
        });
    });
});

describe('catalogue de départ (8 fiches)', () => {
    it('chaque fiche est complète, sourcée, sans montant ni pourcentage', () => {
        expect(programsJson).toHaveLength(8);
        for (const p of programsJson) {
            expect(criteriaSchema.safeParse(p.criteria).success).toBe(true);
            expect(p.official_url).toMatch(/^https:\/\//);
            expect(p.source_label.length).toBeGreaterThan(5);
            expect(criteriaLabels(criteriaSchema.parse(p.criteria)).length).toBeGreaterThan(0);
            const text = `${p.name} ${p.summary} ${p.how_to_apply} ${p.required_documents.join(' ')} ${JSON.stringify(p.criteria)}`;
            expect(text).not.toMatch(/\$|%|€|\bdollars?\b|\btaux\b/i);
        }
    });

    it('les organismes attendus sont couverts', () => {
        const orgs = programsJson.map((p) => p.organization).join(' | ');
        for (const org of ['Revenu Québec', 'RAMQ', 'Agence du revenu du Canada', 'Société d’habitation du Québec', 'CLSC', 'L’Appui']) {
            expect(orgs).toContain(org);
        }
    });
});

describe('table de vérité des deux familles fictives', () => {
    it('famille A : mère de 82 ans à domicile, aidée par sa fille qui n’habite pas avec elle', () => {
        expect(levels(factsFromAnswers(FAMILY_A))).toEqual({
            'credit-maintien-domicile-aines': 'likely',
            'credit-personne-aidante': 'possible',
            'pefsad-aide-domestique': 'likely',
            'montant-canadien-aidant-naturel': 'possible',
            'credit-impot-personnes-handicapees': 'possible',
            'programme-adaptation-domicile': 'possible',
            'soutien-domicile-clsc': 'likely',
            'lappui-info-aidant-repit': 'likely'
        });
    });

    it('famille B : père de 79 ans en RPA, en attente d’un CHSLD, avec une incapacité grave', () => {
        expect(levels(factsFromAnswers(FAMILY_B))).toEqual({
            'credit-maintien-domicile-aines': 'likely',
            'credit-personne-aidante': 'likely',
            'pefsad-aide-domestique': 'unlikely',
            'montant-canadien-aidant-naturel': 'likely',
            'credit-impot-personnes-handicapees': 'likely',
            'programme-adaptation-domicile': 'unlikely',
            'soutien-domicile-clsc': 'likely',
            'lappui-info-aidant-repit': 'likely'
        });
    });

    it('en CHSLD : ni maintien à domicile ni soutien à domicile ; l’aide aux proches aidants reste', () => {
        const result = levels(factsFromAnswers({ ...FAMILY_B, living_setting: 'chsld' }));
        expect(result['credit-maintien-domicile-aines']).toBe('unlikely');
        expect(result['soutien-domicile-clsc']).toBe('unlikely');
        expect(result['lappui-info-aidant-repit']).toBe('likely');
    });

    it('crédit pour personne aidante : 70 ans ou plus ET cohabitation, ou déficience grave', () => {
        const base = { ...FAMILY_A, severe_prolonged_impairment: 'no' as const };
        expect(levels(factsFromAnswers({ ...base, recipient_age: 72, caregiver_cohabits: 'yes' }))['credit-personne-aidante']).toBe(
            'likely'
        );
        expect(levels(factsFromAnswers({ ...base, recipient_age: 65, caregiver_cohabits: 'yes' }))['credit-personne-aidante']).toBe(
            'unlikely'
        );
        expect(levels(factsFromAnswers({ ...base, recipient_age: 72, caregiver_cohabits: 'no' }))['credit-personne-aidante']).toBe(
            'unlikely'
        );
    });

    it('questionnaire vide : rien de « peu probable » sans raison, seulement des possibilités', () => {
        const empty = factsFromAnswers({
            recipient_age: null,
            living_setting: null,
            pays_home_support_services: 'unknown',
            domestic_help: 'unknown',
            severe_prolonged_impairment: 'unknown',
            impairment_dependency: 'unknown',
            caregiver_cohabits: 'unknown',
            needs_home_adaptation: 'unknown'
        });
        const result = levels(empty);
        expect(Object.values(result).filter((l) => l === 'unlikely')).toEqual([]);
        expect(result['lappui-info-aidant-repit']).toBe('likely');
    });

    it('les résultats sont triés : probables, possibles, puis peu probables', () => {
        const order = assessPrograms(programs, factsFromAnswers(FAMILY_B)).map((r) => r.assessment.level);
        expect(order).toEqual(
            [...order].sort((a, b) => ['likely', 'possible', 'unlikely'].indexOf(a) - ['likely', 'possible', 'unlikely'].indexOf(b))
        );
    });
});
