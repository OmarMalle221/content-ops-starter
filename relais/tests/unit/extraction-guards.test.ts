import { describe, expect, it } from 'vitest';
import { guardAndRestore } from '../../src/shared/extraction/guards';
import { draftSchema, type ModelOutput } from '../../src/shared/extraction/schema';
import { pseudonymize } from '../../src/shared/pseudonymize/pseudonymize';

const SOURCE = [
    'RÉSUMÉ DE DÉPART',
    'Médecin : Dre Isabelle Fortin, gériatre',
    'Date de départ : 3 octobre 2026',
    'Médicaments :',
    '- Metformine 500 mg BID',
    '- Ramipril 5 mg 1 fois par jour',
    'Le médecin recommande de diminuer la dose de ramipril si étourdissements.',
    'Prise de sang : résultats normaux.',
    'Rendez-vous le 12/11/2026 à 10 h 30 en gériatrie.'
].join('\n');

const pseudo = pseudonymize(SOURCE, { persons: ['Dre Isabelle Fortin'], addresses: [] });

function output(overrides: Partial<ModelOutput> = {}): ModelOutput {
    return {
        document_type: 'discharge_summary',
        document_date: '2026-10-03',
        author: 'Dre [PERSONNE_1], gériatre',
        title: 'Résumé de départ de l’hôpital',
        plain_summary: 'Retour de l’hôpital le 3 octobre. Le document liste des médicaments.',
        medications_as_written: [
            { name: 'Metformine', dosage: '500 mg', frequency: 'BID', source_line: '- Metformine 500 mg BID' },
            { name: 'Ramipril', dosage: '5 mg', frequency: '1 fois par jour', source_line: '- Ramipril 5 mg 1 fois par jour' }
        ],
        appointments: [
            {
                date: '2026-11-12',
                time: '10 h 30',
                place: null,
                purpose: 'Rendez-vous en gériatrie',
                source_line: 'Rendez-vous le 12/11/2026 à 10 h 30 en gériatrie.'
            }
        ],
        action_items: [],
        timeline_events: [
            { date: '2026-10-03', event_type: 'discharge', title: 'Retour de l’hôpital', source_line: 'Date de départ : 3 octobre 2026' }
        ],
        legibility: 'clear',
        needs_review: false,
        review_reasons: [],
        ...overrides
    };
}

const guard = (o: ModelOutput) => guardAndRestore(o, pseudo.text, pseudo.mapping);

describe('garde-fous de l’extraction (règles 1 et 3)', () => {
    it('laisse passer un brouillon fidèle et ré-identifie l’auteur', () => {
        const { draft, flagged } = guard(output());
        expect(flagged).toBe(false);
        expect(draft.needs_review).toBe(false);
        expect(draft.author).toBe('Dre Isabelle Fortin, gériatre');
        expect(draft.plain_summary).toContain('3 octobre');
        expect(draft.medications.every((m) => !m.unverified)).toBe(true);
        expect(draft.appointments[0]).toMatchObject({ date: '2026-11-12', unverified: false });
        expect(draftSchema.safeParse(draft).success).toBe(true);
    });

    it('retire un résumé qui donne un conseil absent du document', () => {
        const { draft, flagged } = guard(output({ plain_summary: 'Vous devriez augmenter la dose de metformine.' }));
        expect(flagged).toBe(true);
        expect(draft.plain_summary).toBeNull();
        expect(draft.guard_flags).toContain('advice_language');
        expect(draft.review_reasons).toContain('summary_removed');
        expect(draft.needs_review).toBe(true);
    });

    it('retire une interprétation absente du document (« normal », « inquiétant »)', () => {
        for (const summary of ['La glycémie est normale.', 'Ces résultats sont inquiétants.', 'Rien de grave.', 'C’est bon signe.']) {
            expect(guard(output({ plain_summary: summary })).draft.plain_summary).toBeNull();
        }
    });

    it('accepte une consigne ou un mot que le document contient lui-même', () => {
        const { draft } = guard(
            output({ plain_summary: 'Le document indique de diminuer la dose de ramipril si étourdissements. Résultats normaux.' })
        );
        expect(draft.plain_summary).not.toBeNull();
        expect(draft.guard_flags).toEqual([]);
    });

    it('retire un résumé qui contient un chiffre inventé', () => {
        const { draft } = guard(output({ plain_summary: 'Il prend 4 médicaments par jour.' }));
        expect(draft.plain_summary).toBeNull();
        expect(draft.guard_flags).toContain('invented_number');
    });

    it('marque « à vérifier » un médicament, une dose ou une fréquence qui ne sont pas écrits ainsi', () => {
        const { draft } = guard(
            output({
                medications_as_written: [
                    { name: 'Metformine', dosage: '1000 mg', frequency: 'BID', source_line: '- Metformine 500 mg BID' },
                    { name: 'Metformine', dosage: '500 mg', frequency: '2 fois par jour', source_line: '- Metformine 500 mg BID' },
                    { name: 'Aspirine', dosage: '81 mg', frequency: null, source_line: 'Aspirine 81 mg' },
                    { name: 'Metformine', dosage: '500mg', frequency: 'BID', source_line: '- Metformine 500 mg BID' }
                ]
            })
        );
        expect(draft.medications.map((m) => m.unverified)).toEqual([true, true, true, false]);
        expect(draft.review_reasons).toContain('not_in_source');
        expect(draft.guard_flags).toContain('not_in_source');
    });

    it('retire une date qui ne correspond à rien d’écrit', () => {
        const { draft } = guard(output({ document_date: '2026-10-04' }));
        expect(draft.document_date).toBeNull();
        expect(draft.review_reasons).toContain('ambiguous_date');
        expect(guard(output({ document_date: '2026-02-30' })).draft.document_date).toBeNull();
    });

    it('reconnaît une date écrite en chiffres (12/11/2026) ou en lettres (3 octobre 2026)', () => {
        const { draft } = guard(output());
        expect(draft.document_date).toBe('2026-10-03');
        expect(draft.appointments[0]?.date).toBe('2026-11-12');
    });

    it('remplace un titre qui contient un conseil par un titre neutre', () => {
        expect(guard(output({ title: 'Il faut arrêter le traitement' })).draft.title).toBe('Résumé de départ de l’hôpital');
    });

    it('ne rétablit jamais un NAM et signale un jeton inconnu', () => {
        const withNam = pseudonymize('NAM : GAGR 4503 1512', { persons: [], addresses: [] });
        const { draft } = guardAndRestore(
            output({ plain_summary: 'Document de [NAM_1] pour [PERSONNE_7].', author: null }),
            withNam.text,
            withNam.mapping
        );
        expect(draft.plain_summary).toBe('Document de [NAM masqué] pour [renseignement masqué].');
        expect(draft.guard_flags).toContain('unknown_token');
    });

    it('marque « à vérifier » un document manuscrit ou flou', () => {
        const { draft } = guard(output({ legibility: 'handwritten' }));
        expect(draft.needs_review).toBe(true);
        expect(draft.review_reasons).toContain('handwriting');
    });

    it('raccourcit un résumé trop long', () => {
        const long = 'Le document liste des médicaments. '.repeat(30);
        const { draft } = guard(output({ plain_summary: long }));
        expect(draft.plain_summary!.length).toBeLessThanOrEqual(601);
        expect(draft.guard_flags).toContain('truncated');
        expect(draftSchema.safeParse(draft).success).toBe(true);
    });

    it('n’accepte qu’un auteur dont les mots figurent dans le document', () => {
        const { draft } = guard(output({ author: 'Dr House, CHUM' }));
        expect(draft.author).toBeNull();
        expect(draft.review_reasons).toContain('not_in_source');
    });
});
