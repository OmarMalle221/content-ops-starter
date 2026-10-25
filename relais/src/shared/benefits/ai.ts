// Explication d'un programme et modèle de lettre : l'IA ne reçoit que la fiche (aucune donnée
// personnelle) et ne doit rien inventer (règle no 3). Garde-fous déterministes :
// - aucun montant, taux ni pourcentage ;
// - aucun chiffre absent de la fiche (montant, délai, âge, numéro de formulaire…) ;
// - dans une lettre, seulement les espaces réservés prévus, remplis ensuite sur le téléphone.
// Si un garde-fou refuse la sortie, l'application dit qu'elle ne sait pas et montre la fiche.
import { z } from 'zod';
import { criteriaLabels, type Criteria } from './engine.ts';

export interface ProgramFiche {
    name: string;
    organization: string;
    summary: string;
    criteria_labels: string[];
    required_documents: string[];
    how_to_apply: string | null;
    source_label: string;
}

export function ficheFromProgram(program: {
    name: string;
    organization: string;
    summary: string;
    criteria: Criteria;
    required_documents: string[];
    how_to_apply: string | null;
    source_label: string;
}): ProgramFiche {
    return {
        name: program.name,
        organization: program.organization,
        summary: program.summary,
        criteria_labels: criteriaLabels(program.criteria),
        required_documents: program.required_documents,
        how_to_apply: program.how_to_apply,
        source_label: program.source_label
    };
}

export function ficheText(fiche: ProgramFiche): string {
    return [
        `Programme : ${fiche.name}`,
        `Organisme : ${fiche.organization}`,
        `Description : ${fiche.summary}`,
        `Conditions indiquées : ${fiche.criteria_labels.join(' ; ') || 'aucune'}`,
        `Pièces à fournir : ${fiche.required_documents.join(' ; ') || 'aucune indiquée'}`,
        `Comment faire la demande : ${fiche.how_to_apply ?? 'non indiqué'}`,
        `Source : ${fiche.source_label}`
    ].join('\n');
}

// ------------------------------------------------------------------------------------------- schémas
export const explanationOutputSchema = z.object({
    plain_explanation: z.string().describe('Explication en français simple, 700 caractères au plus, tirée de la fiche seulement'),
    who_it_may_help: z.array(z.string()).describe('À qui le programme peut s’adresser, selon la fiche'),
    steps: z.array(z.string()).describe('Les étapes de la demande, selon la fiche'),
    not_in_fiche: z
        .array(z.string())
        .describe('Ce que la fiche ne précise pas et qu’il faut demander à l’organisme (par exemple le montant ou les délais)')
});
export type ExplanationOutput = z.infer<typeof explanationOutputSchema>;

export const LETTER_KINDS = ['information_request', 'application_follow_up'] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

export const letterOutputSchema = z.object({
    letter: z.string().describe('La lettre complète, avec les espaces réservés prévus pour tout renseignement personnel')
});
export type LetterOutput = z.infer<typeof letterOutputSchema>;

/** Espaces réservés permis dans une lettre ; remplis sur le téléphone ou par la personne elle-même. */
export const LETTER_PLACEHOLDERS = [
    '[NOM DE LA PERSONNE AIDÉE]',
    '[VOTRE NOM]',
    '[DATE]',
    '[VOTRE ADRESSE]',
    '[VOTRE TÉLÉPHONE]',
    '[NUMÉRO DE DOSSIER]'
] as const;
export const UNKNOWN_PLACEHOLDER = '[À COMPLÉTER]';

export const LIMITS = { explanation: 700, item: 240, items: 8, letter: 4000 } as const;

// ------------------------------------------------------------------------------------------ garde-fous
const AMOUNT = /(\$|%|€|\bdollars?\b|\bcents?\b|\btaux\b)/i;
const numbersIn = (text: string): string[] =>
    text
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/(\d)[\s\u00a0](?=\d{3}\b)/g, '$1')
        .match(/\d+(?:[.,]\d+)?/g) ?? [];

export type GuardFailure = 'amount' | 'invented_number' | 'too_long' | 'empty';

/** Vrai si le texte n'a ni montant ni chiffre absent de la fiche. */
function faithful(text: string, allowedNumbers: Set<string>): GuardFailure | null {
    if (AMOUNT.test(text)) return 'amount';
    if (numbersIn(text).some((n) => !allowedNumbers.has(n))) return 'invented_number';
    return null;
}

export function guardExplanation(
    output: ExplanationOutput,
    fiche: ProgramFiche
): { ok: true; explanation: ExplanationOutput } | { ok: false; reason: GuardFailure } {
    const allowed = new Set(numbersIn(ficheText(fiche)));
    const texts = [output.plain_explanation, ...output.who_it_may_help, ...output.steps, ...output.not_in_fiche];
    if (output.plain_explanation.trim() === '') return { ok: false, reason: 'empty' };
    if (output.plain_explanation.length > LIMITS.explanation + 100) return { ok: false, reason: 'too_long' };
    for (const text of texts) {
        const failure = faithful(text, allowed);
        if (failure) return { ok: false, reason: failure };
    }
    const tidy = (items: string[]) =>
        items
            .map((i) => i.trim())
            .filter(Boolean)
            .slice(0, LIMITS.items)
            .map((i) => i.slice(0, LIMITS.item));
    return {
        ok: true,
        explanation: {
            plain_explanation: output.plain_explanation.trim().slice(0, LIMITS.explanation),
            who_it_may_help: tidy(output.who_it_may_help),
            steps: tidy(output.steps),
            not_in_fiche: tidy(output.not_in_fiche)
        }
    };
}

export function guardLetter(output: LetterOutput, fiche: ProgramFiche): { ok: true; letter: string } | { ok: false; reason: GuardFailure } {
    const letter = output.letter.trim();
    if (letter === '') return { ok: false, reason: 'empty' };
    if (letter.length > LIMITS.letter) return { ok: false, reason: 'too_long' };
    const failure = faithful(letter, new Set(numbersIn(ficheText(fiche))));
    if (failure) return { ok: false, reason: failure };
    // Un espace réservé inconnu devient « [À COMPLÉTER] » : rien d'autre ne sera rempli automatiquement.
    const allowed = new Set<string>(LETTER_PLACEHOLDERS);
    return { ok: true, letter: letter.replace(/\[[^\]\n]{1,60}\]/g, (token) => (allowed.has(token) ? token : UNKNOWN_PLACEHOLDER)) };
}

/** Remplit sur le téléphone les espaces réservés connus ; les autres restent à compléter. */
export function fillPlaceholders(template: string, values: Partial<Record<(typeof LETTER_PLACEHOLDERS)[number], string>>): string {
    return template.replace(/\[[^\]\n]{1,60}\]/g, (token) => {
        const value = values[token as (typeof LETTER_PLACEHOLDERS)[number]];
        return value && value.trim() ? value.trim() : token;
    });
}
