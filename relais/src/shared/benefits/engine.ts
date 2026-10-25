// Navigateur de droits : moteur de règles en TypeScript pur, SANS IA (règle non négociable no 3).
//
// Chaque fiche porte ses critères dans un petit langage JSON :
//   { "all": [ { "fact": "recipient_age", "op": ">=", "value": 70, "label": "La personne a 70 ans ou plus" }, … ] }
// Logique à trois valeurs : une réponse « je ne sais pas » rend le critère inconnu.
//   tous remplis → « likely » ; au moins un inconnu, aucun échec → « possible » ; un échec → « unlikely ».
// Les raisons affichées sont les libellés écrits dans la fiche, jamais du texte généré.
import { z } from 'zod';

export const LIVING_SETTINGS = ['home', 'rpa', 'intermediate_resource', 'chsld', 'hospital', 'other'] as const;
export type LivingSetting = (typeof LIVING_SETTINGS)[number];

/** Faits que le questionnaire renseigne (et que les fiches peuvent tester). */
export const FACTS = [
    'recipient_age',
    'living_setting',
    'pays_home_support_services',
    'domestic_help',
    'severe_prolonged_impairment',
    'impairment_dependency',
    'caregiver_cohabits',
    'needs_home_adaptation',
    'is_caregiver'
] as const;
export type Fact = (typeof FACTS)[number];

export interface Facts {
    recipient_age?: number | null;
    living_setting?: LivingSetting | null;
    pays_home_support_services?: boolean | null;
    domestic_help?: boolean | null;
    severe_prolonged_impairment?: boolean | null;
    impairment_dependency?: boolean | null;
    caregiver_cohabits?: boolean | null;
    needs_home_adaptation?: boolean | null;
    is_caregiver?: boolean | null;
}

export const OPERATORS = ['==', '!=', '>=', '<=', '>', '<', 'in', 'not_in'] as const;

export const conditionSchema = z
    .object({
        fact: z.enum(FACTS),
        op: z.enum(OPERATORS),
        value: z.union([z.number(), z.boolean(), z.string(), z.array(z.string()).min(1)]),
        label: z.string().trim().min(1).max(200)
    })
    .strict();
export type Condition = z.infer<typeof conditionSchema>;

export type Criteria = { all: Rule[] } | { any: Rule[] };
export type Rule = Condition | Criteria;

export const ruleSchema: z.ZodType<Rule> = z.lazy(() => z.union([conditionSchema, criteriaSchema]));
export const criteriaSchema: z.ZodType<Criteria> = z.lazy(() =>
    z.union([z.object({ all: z.array(ruleSchema) }).strict(), z.object({ any: z.array(ruleSchema).min(1) }).strict()])
);

export type Outcome = 'met' | 'not_met' | 'unknown';
export type MatchLevel = 'likely' | 'possible' | 'unlikely';

export interface Reason {
    label: string;
    status: Outcome;
}

export interface Assessment {
    level: MatchLevel;
    reasons: Reason[];
}

function compare(condition: Condition, fact: unknown): Outcome {
    if (fact === undefined || fact === null) return 'unknown';
    const { op, value } = condition;
    switch (op) {
        case '==':
            return fact === value ? 'met' : 'not_met';
        case '!=':
            return fact !== value ? 'met' : 'not_met';
        case 'in':
        case 'not_in': {
            if (!Array.isArray(value) || typeof fact !== 'string') return 'unknown';
            const inside = value.includes(fact);
            return inside === (op === 'in') ? 'met' : 'not_met';
        }
        default: {
            if (typeof fact !== 'number' || typeof value !== 'number') return 'unknown';
            const ok = op === '>=' ? fact >= value : op === '<=' ? fact <= value : op === '>' ? fact > value : fact < value;
            return ok ? 'met' : 'not_met';
        }
    }
}

function evaluate(rule: Rule, facts: Facts, reasons: Reason[]): Outcome {
    if ('fact' in rule) {
        const outcome = compare(rule, facts[rule.fact]);
        reasons.push({ label: rule.label, status: outcome });
        return outcome;
    }
    // Toutes les branches sont évaluées : chaque raison s'affiche, même après une conclusion.
    const outcomes = ('all' in rule ? rule.all : rule.any).map((child) => evaluate(child, facts, reasons));
    if ('all' in rule) {
        if (outcomes.includes('not_met')) return 'not_met';
        return outcomes.includes('unknown') ? 'unknown' : 'met';
    }
    if (outcomes.includes('met')) return 'met';
    return outcomes.includes('unknown') ? 'unknown' : 'not_met';
}

export function assess(criteria: Criteria, facts: Facts): Assessment {
    const reasons: Reason[] = [];
    const outcome = evaluate(criteria, facts, reasons);
    return { level: outcome === 'met' ? 'likely' : outcome === 'unknown' ? 'possible' : 'unlikely', reasons };
}

/** Libellés des critères d'une fiche, dans l'ordre (pour l'affichage et pour l'IA). */
export function criteriaLabels(criteria: Criteria): string[] {
    const out: string[] = [];
    const walk = (rule: Rule) => {
        if ('fact' in rule) out.push(rule.label);
        else ('all' in rule ? rule.all : rule.any).forEach(walk);
    };
    walk(criteria);
    return [...new Set(out)];
}

// ------------------------------------------------------------------------------------- questionnaire
const triState = z.enum(['yes', 'no', 'unknown']);
export type TriState = z.infer<typeof triState>;

export const QUESTION_FACTS = [
    'pays_home_support_services',
    'domestic_help',
    'severe_prolonged_impairment',
    'impairment_dependency',
    'caregiver_cohabits',
    'needs_home_adaptation'
] as const;
export type QuestionFact = (typeof QUESTION_FACTS)[number];

export const answersSchema = z.object({
    recipient_age: z.number().int().min(18).max(120).nullable(),
    living_setting: z.enum(LIVING_SETTINGS).nullable(),
    pays_home_support_services: triState,
    domestic_help: triState,
    severe_prolonged_impairment: triState,
    impairment_dependency: triState,
    caregiver_cohabits: triState,
    needs_home_adaptation: triState
});
export type BenefitAnswers = z.infer<typeof answersSchema>;

const fromTri = (value: TriState): boolean | null => (value === 'yes' ? true : value === 'no' ? false : null);

export function factsFromAnswers(answers: BenefitAnswers): Facts {
    return {
        recipient_age: answers.recipient_age,
        living_setting: answers.living_setting,
        pays_home_support_services: fromTri(answers.pays_home_support_services),
        domestic_help: fromTri(answers.domestic_help),
        severe_prolonged_impairment: fromTri(answers.severe_prolonged_impairment),
        impairment_dependency: fromTri(answers.impairment_dependency),
        caregiver_cohabits: fromTri(answers.caregiver_cohabits),
        needs_home_adaptation: fromTri(answers.needs_home_adaptation),
        // La personne qui remplit le questionnaire aide un proche.
        is_caregiver: true
    };
}

export interface ProgramForEngine {
    id: string;
    criteria: Criteria;
    sort_order: number;
}

export interface ProgramResult<P extends ProgramForEngine> {
    program: P;
    assessment: Assessment;
}

const LEVEL_RANK: Record<MatchLevel, number> = { likely: 0, possible: 1, unlikely: 2 };

/** Résultat pour chaque fiche, du plus au moins probable, puis dans l'ordre du catalogue. */
export function assessPrograms<P extends ProgramForEngine>(programs: P[], facts: Facts): Array<ProgramResult<P>> {
    return programs
        .map((program) => ({ program, assessment: assess(program.criteria, facts) }))
        .sort((a, b) => LEVEL_RANK[a.assessment.level] - LEVEL_RANK[b.assessment.level] || a.program.sort_order - b.program.sort_order);
}
