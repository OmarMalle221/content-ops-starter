// Pseudonymisation d'un texte avant tout envoi à un fournisseur d'IA (règle non négociable no 6).
//
// - Dictionnaire du dossier : noms (personne aidée, membres, contacts, représentant) et adresses connues.
// - Motifs : courriel, NAM, numéros de dossier, date de naissance, adresses, code postal, téléphone,
//   NAS, noms précédés d'un titre (Dr, Dre, Mme, M.…) ou d'une étiquette (« Patient : »).
// - Chaque valeur devient un jeton stable ([PERSONNE_1], [ADRESSE_2]…). La table de correspondance reste
//   en mémoire dans la fonction serveur : elle n'est ni stockée, ni journalisée, ni envoyée.
// - Ré-identification locale de la réponse : noms, adresses, téléphones et courriels sont rétablis ;
//   NAM, NAS, dates de naissance, codes postaux et numéros de dossier restent masqués (minimisation).
// Risque résiduel (à déclarer dans l'EFVP) : un nom inconnu du dossier, sans titre ni étiquette, passe.

export type PseudonymCategory =
    'person' | 'address' | 'health_card' | 'sin' | 'postal_code' | 'phone' | 'email' | 'birth_date' | 'record_number';

const TOKEN_LABEL: Record<PseudonymCategory, string> = {
    person: 'PERSONNE',
    address: 'ADRESSE',
    health_card: 'NAM',
    sin: 'NAS',
    postal_code: 'CODE_POSTAL',
    phone: 'TELEPHONE',
    email: 'COURRIEL',
    birth_date: 'DATE_NAISSANCE',
    record_number: 'NUMERO_DOSSIER'
};
const CATEGORY_BY_LABEL = new Map(Object.entries(TOKEN_LABEL).map(([category, label]) => [label, category as PseudonymCategory]));

const STRUCTURED = new Set<PseudonymCategory>(['health_card', 'sin', 'postal_code', 'phone', 'record_number']);

/** Ce qui est rétabli dans le brouillon ; le reste demeure masqué. */
const RESTORABLE = new Set<PseudonymCategory>(['person', 'address', 'phone', 'email']);
const MASKED_LABEL: Record<PseudonymCategory, string> = {
    person: '[nom masqué]',
    address: '[adresse masquée]',
    health_card: '[NAM masqué]',
    sin: '[NAS masqué]',
    postal_code: '[code postal masqué]',
    phone: '[téléphone masqué]',
    email: '[courriel masqué]',
    birth_date: '[date de naissance masquée]',
    record_number: '[numéro masqué]'
};
export const UNKNOWN_TOKEN_LABEL = '[renseignement masqué]';

export interface PseudonymDictionary {
    persons: readonly string[];
    addresses: readonly string[];
}

export interface PseudonymEntry {
    category: PseudonymCategory;
    value: string;
}

export interface Pseudonymized {
    text: string;
    /** Jeton → valeur d'origine. En mémoire seulement. */
    mapping: Map<string, PseudonymEntry>;
    /** Nombre de remplacements par catégorie (jamais les valeurs) : seul ceci est journalisé. */
    counts: Partial<Record<PseudonymCategory, number>>;
}

/** Minuscules, sans accents, apostrophes et espaces uniformisés. */
export function fold(value: string): string {
    return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ACCENT_VARIANTS: Record<string, string> = {
    a: 'aàâäáã',
    c: 'cç',
    e: 'eéèêë',
    i: 'iîïíì',
    o: 'oôöóò',
    u: 'uùûüú',
    y: 'yÿ',
    n: 'nñ'
};

/** Motif tolérant aux accents, à la casse, aux espaces, traits d'union et virgules. */
function flexiblePattern(term: string): string {
    let out = '';
    for (const ch of fold(term)) {
        if (ch === ' ') out += '[\\s\\u00a0]+';
        else if (ch === '-') out += '[-‐\\s]?';
        else if (ch === "'") out += "['’]";
        else if (ch === ',') out += ',?';
        else if (ch === '.') out += '\\.?';
        else if (ACCENT_VARIANTS[ch]) out += `[${ACCENT_VARIANTS[ch]}]`;
        else out += escapeRegExp(ch);
    }
    return out;
}

const wordBounded = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');

// Titres et petits mots qui ne sont pas des noms (on ne masque pas « Dre » ni « de » seuls).
const NAME_STOPWORDS = new Set([
    'dr',
    'dre',
    'docteur',
    'docteure',
    'mme',
    'mlle',
    'm',
    'madame',
    'monsieur',
    'me',
    'pr',
    'pre',
    'de',
    'du',
    'des',
    'la',
    'le',
    'les',
    'van',
    'von',
    'st',
    'ste',
    'saint',
    'sainte'
]);

// Types de voie après un numéro civique. « place » et « côte » sont exclus : « 1 place disponible »,
// « 1 côte fracturée » ne sont pas des adresses.
const STREET_TYPES =
    'rue|avenue|av\\.|boulevard|boul\\.|bd|chemin|ch\\.|rang|route|mont[ée]e|all[ée]e|croissant|impasse|promenade|terrasse';
const DATE_VALUE = String.raw`\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:er)?\s+\p{L}+\.?\s+\d{4}`;

interface PatternRule {
    category: PseudonymCategory;
    regex: RegExp;
    /** Groupe à remplacer (0 = toute la correspondance) ; ce qui précède est conservé (étiquette, titre). */
    group?: number;
}

const PATTERNS_BEFORE_DICTIONARY: PatternRule[] = [
    { category: 'email', regex: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu },
    { category: 'health_card', regex: /(?<![\p{L}\p{N}])[A-Za-z]{4}[ -]?\d{4}[ -]?\d{4}(?![\p{L}\p{N}])/gu },
    {
        category: 'record_number',
        regex: /((?:n[o°º]\.?|num[ée]ro|#)\s*(?:de\s+|du\s+|d['’])?(?:dossier|usager|patient|bénéficiaire|carte|assurance)\s*[:#]?\s*|dossier\s*(?:n[o°º]\.?|#)\s*:?\s*|\bMRN\s*[:#]?\s*)([A-Za-z]{0,4}[- ]?\d[\d -]{1,18}\d|\d{3,})/giu,
        group: 2
    },
    {
        category: 'birth_date',
        regex: new RegExp(String.raw`((?:n[ée]e?\s+le|date\s+de\s+naissance|DDN|D\.D\.N\.)\s*:?\s*)(${DATE_VALUE})`, 'giu'),
        group: 2
    }
];

const ADDRESS_PATTERN: PatternRule = {
    category: 'address',
    regex: new RegExp(String.raw`(?<![\p{L}\p{N}])\d{1,5}(?:[-–]\d{1,5})?,?\s+(?:${STREET_TYPES})(?![\p{L}])[^\n,;()]{1,60}`, 'giu')
};

const PATTERNS_AFTER_ADDRESSES: PatternRule[] = [
    {
        category: 'postal_code',
        regex: /(?<![\p{L}\p{N}])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![\p{L}\p{N}])/giu
    },
    {
        category: 'phone',
        regex: /(?<![\p{N}])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?:\s*(?:poste|p\.|ext\.?|#)\s*\d{1,6})?(?![\p{N}])/gu
    },
    { category: 'sin', regex: /(?<![\p{N}])\d{3}[ -]?\d{3}[ -]?\d{3}(?![\p{N}])/gu }
];

const PATTERNS_AFTER_DICTIONARY: PatternRule[] = [
    // Nom précédé d'un titre : le titre reste (« Dre [PERSONNE_2] »), utile au résumé.
    {
        category: 'person',
        // Jamais au-delà de la ligne : « Dre Fortin » en fin de ligne n'avale pas la ligne suivante.
        regex: /((?<![\p{L}])(?:Dre?|Docteure?|Mme|Mlle|M\.|Madame|Monsieur|Me|Pre?)\.?[ \t\u00a0]+)((?:[\p{Lu}][\p{L}'’-]*)(?:[ \t\u00a0]+(?:de[ \t]+|du[ \t]+|van[ \t]+)?[\p{Lu}][\p{L}'’-]+){0,2})/gu,
        group: 2
    },
    // Nom après une étiquette : « Patient : GAGNON, Roger ».
    {
        category: 'person',
        regex: /((?<![\p{L}])(?:Nom(?:\s+du\s+patient|\s+de\s+l['’]usager(?:ère)?)?|Patiente?|Usager|Usagère|Bénéficiaire|Résidente?|Signature)\s*:\s*)([^\n[]{2,60})/giu,
        group: 2
    }
];

/** Remplace les identifiants du texte par des jetons. */
export function pseudonymize(text: string, dictionary: PseudonymDictionary): Pseudonymized {
    const mapping = new Map<string, PseudonymEntry>();
    const tokenByValue = new Map<string, string>();
    const counters = new Map<PseudonymCategory, number>();
    const counts: Partial<Record<PseudonymCategory, number>> = {};

    // Une valeur peut contenir un jeton posé plus tôt (ex. un téléphone dans une adresse) : on garde
    // l'original complet.
    const expand = (value: string) =>
        value
            .replace(/\[[A-Z_]+_\d+\]/g, (token) => mapping.get(token)?.value ?? token)
            .replace(/\s+/g, ' ')
            .trim();

    const tokenFor = (category: PseudonymCategory, rawValue: string): string => {
        const value = expand(rawValue);
        // Un même numéro écrit de deux façons (« 514 555-0142 », « 514-555-0142 ») garde son jeton.
        const key = `${category}|${STRUCTURED.has(category) ? fold(value).replace(/[^\p{L}\p{N}]/gu, '') : fold(value)}`;
        let token = tokenByValue.get(key);
        if (!token) {
            const n = (counters.get(category) ?? 0) + 1;
            counters.set(category, n);
            token = `[${TOKEN_LABEL[category]}_${n}]`;
            tokenByValue.set(key, token);
            mapping.set(token, { category, value });
        }
        counts[category] = (counts[category] ?? 0) + 1;
        return token;
    };

    const applyRule = (input: string, rule: PatternRule): string =>
        input.replace(rule.regex, (...args: unknown[]) => {
            const match = args[0] as string;
            if (!rule.group) {
                const trailing = match.match(/[\s.]*$/)?.[0] ?? '';
                const core = match.slice(0, match.length - trailing.length);
                return core ? tokenFor(rule.category, core) + trailing : match;
            }
            const prefix = (args[1] as string | undefined) ?? '';
            const value = (args[rule.group] as string | undefined) ?? '';
            const trimmed = value.replace(/[\s,.;:]+$/, '');
            // Rien à masquer, ou seulement un titre (« Signature : Dre [PERSONNE_1] »).
            if (!trimmed || (rule.category === 'person' && NAME_STOPWORDS.has(fold(trimmed).replace(/\.$/, '')))) return match;
            return prefix + tokenFor(rule.category, trimmed) + value.slice(trimmed.length);
        });

    const applyTerms = (input: string, category: PseudonymCategory, terms: string[]): string => {
        let out = input;
        const unique = [...new Map(terms.map((t) => [fold(t), t])).values()].sort((a, b) => b.length - a.length);
        for (const term of unique) {
            out = out.replace(wordBounded(flexiblePattern(term)), (match) => tokenFor(category, match));
        }
        return out;
    };

    let out = text;
    for (const rule of PATTERNS_BEFORE_DICTIONARY) out = applyRule(out, rule);
    out = applyTerms(
        out,
        'address',
        dictionary.addresses.filter((a) => fold(a).length >= 5)
    );
    out = applyRule(out, ADDRESS_PATTERN);
    for (const rule of PATTERNS_AFTER_ADDRESSES) out = applyRule(out, rule);

    const personTerms: string[] = [];
    for (const name of dictionary.persons) {
        const cleaned = name.trim();
        if (fold(cleaned).length < 2) continue;
        const parts = cleaned.split(/\s+/).filter((part) => {
            const folded = fold(part).replace(/\.$/, '');
            return folded.length >= 3 && !NAME_STOPWORDS.has(folded);
        });
        // Le nom complet, sans son titre, puis chaque partie significative.
        personTerms.push(parts.join(' '), ...parts);
    }
    out = applyTerms(
        out,
        'person',
        personTerms.filter((t) => fold(t).length >= 3)
    );
    for (const rule of PATTERNS_AFTER_DICTIONARY) out = applyRule(out, rule);

    return { text: out, mapping, counts };
}

const TOKEN_IN_OUTPUT = new RegExp(`\\[?\\b(${[...CATEGORY_BY_LABEL.keys()].join('|')})[_ ](\\d+)\\b\\]?`, 'g');

/** Rétablit les jetons d'une réponse ; NAM, NAS, dates de naissance et numéros restent masqués. */
export function reidentify(text: string, mapping: Map<string, PseudonymEntry>): { text: string; unknownTokens: number } {
    let unknownTokens = 0;
    const out = text.replace(TOKEN_IN_OUTPUT, (_match, label: string, n: string) => {
        const entry = mapping.get(`[${label}_${n}]`);
        if (!entry) {
            unknownTokens += 1;
            return UNKNOWN_TOKEN_LABEL;
        }
        return RESTORABLE.has(entry.category) ? entry.value : MASKED_LABEL[entry.category];
    });
    return { text: out, unknownTokens };
}

/** Vrai si le texte contient encore un motif d'identifiant fort (filet de sécurité avant l'envoi). */
export function hasResidualIdentifiers(text: string): boolean {
    return [PATTERNS_BEFORE_DICTIONARY[0], PATTERNS_BEFORE_DICTIONARY[1], ...PATTERNS_AFTER_ADDRESSES].some((rule) => {
        const regex = new RegExp(rule!.regex.source, rule!.regex.flags.replace('g', ''));
        return regex.test(text);
    });
}
