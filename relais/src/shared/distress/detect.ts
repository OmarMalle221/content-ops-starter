// Détecteur de détresse déterministe (règle non négociable no 2).
//
// Il s'exécute sur le téléphone, sur chaque saisie libre. Aucune IA, aucun appel réseau : le même texte
// donne toujours le même résultat, ce qui permet de garantir par des tests qu'une phrase type déclenche
// l'écran d'urgence. En cas de doute, il déclenche. Le texte analysé n'est jamais journalisé.
//
// Le lexique est une première version à faire valider par une travailleuse sociale (VALIDATIONS.md, B1).

export type DistressCategory = 'suicide' | 'harm_to_others' | 'violence' | 'medical_emergency' | 'caregiver_crisis';

/** `danger` : quelqu'un est en danger ; `crisis` : l'aidant est en crise ; `none` : rien détecté. */
export type DistressLevel = 'none' | 'crisis' | 'danger';

export interface DistressResult {
    level: DistressLevel;
    categories: DistressCategory[];
}

/**
 * Minuscules, sans accents, apostrophes uniformisées, ponctuation remplacée par des espaces.
 * « J’VEUX   mourir!! » → « j'veux mourir ».
 */
export function normalizeForDetection(text: string): string {
    return text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[’‘`´]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Formes fréquentes à l'écrit, y compris québécoises : « j'veux », « jveux », « pu » pour « plus »,
// « chu » pour « je suis ».
const WANT = "(?:je veux|j'veux|jveux|veux|voudrais|aimerais|souhaite|prefererais|envie de|envie d')";
const I_AM = "(?:je suis|j'suis|jsuis|chu|chus)";
const NO_MORE = '(?:plus|pu|pas)';

const PATTERNS: Record<DistressCategory, RegExp[]> = {
    suicide: [
        /\bsuicid\w*/,
        /\b(?:me |m')(?:tuer|enlever la vie|oter la vie|pendre|faire du mal|mutiler|automutiler)\b/,
        /\bm'automutil\w*/,
        /\bmettre (?:fin|un terme) a (?:mes jours|ma vie)\b/,
        new RegExp(`\\b(?:${WANT}|vais|pense a|pense d'|penser a) ?en finir\\b`),
        /\ben finir avec (?:la vie|tout|moi)\b/,
        new RegExp(`\\b${NO_MORE} (?:envie|le gout|la force|de raison|capable) de vivre\\b`),
        /\baucune raison de vivre\b/,
        new RegExp(`\\b${WANT} ?(?:de )?mourir\\b`),
        /\b(?:veux|voudrais) (?:plus|pu) vivre\b/,
        /\bmieux morte?s?\b/,
        /\b(?:serait|seraient|serais) mieux sans moi\b/,
        /\b(?:plus|pu|jamais) me reveiller\b/,
        /\bme jeter (?:en bas|devant|sous|du|d'un)\b/,
        /\bsauter (?:du|d'un|en bas d'un) (?:pont|toit|balcon|edifice)\b/,
        /\b(?:prendre|avaler) tou(?:s|tes) mes (?:pilules|medicaments|comprimes)\b/,
        /\b(?:overdose|surdose)\b/,
        /\bidees? (?:noires|suicidaires)\b/,
        new RegExp(`\\b(?:${WANT} ?disparaitre|disparaitre pour (?:toujours|de bon))\\b`)
    ],
    harm_to_others: [
        /\b(?:vais|va|pourrais|veux|envie de|peur de) (?:le |la |les |lui |l')(?:tuer|frapper|etrangler|faire mal|faire du mal)\b/,
        /\b(?:le|la|les|lui) faire du mal\b/,
        /\bje l'ai (?:frappee?|battue?|bousculee?|secouee?|brutalisee?|giflee?)\b/
    ],
    violence: [
        /\b(?:me |m'|la |le |les |l')(?:frappe|frappent|menace|menacent|brutalise|brutalisent|attache|attachent)\b/,
        /\b(?:me |m')(?:bat|battent)\b/,
        /\b(?:m'a|ma|l'a|la|les a) (?:frappee?s?|battue?s?|menacee?s?|brutalisee?s?|giflee?s?|bousculee?s?)\b/,
        /\bmaltrait\w*/,
        /\babus (?:financier|physique|sexuel|psychologique)s?\b/,
        /\bviol\b/,
        /\bviolen(?:ce|ces|t|te|ts|tes)\b/,
        /\bj'ai peur (?:de lui|d'elle|pour ma vie|pour sa vie)\b/,
        /\ben danger\b/,
        /\bvol(?:e|ent|er)? (?:son|tout son|mon) argent\b/
    ],
    medical_emergency: [
        new RegExp(`\\b(?:ne |n')?respire ${NO_MORE}\\b`),
        new RegExp(`\\b(?:il|elle|papa|maman) (?:ne |n')?(?:repond|reagit) ${NO_MORE}\\b`),
        /\binconscients?e?s?\b/,
        /\bsans connaissance\b/,
        /\bevanoui\w*/,
        /\b(?:fait|fais|faire) (?:un|une) (?:avc|crise cardiaque|arret cardiaque)\b/,
        /\btombee? et (?:ne |n')?(?:peut|arrive|se releve|repond)\w* (?:pas|plus|pu)\b/,
        /\bsaigne (?:beaucoup|abondamment)\b/,
        /\bs'etouffe\b/
    ],
    caregiver_crisis: [
        new RegExp(`\\b(?:je n'en|j'en|jen|je n'en pouvais|j'en pouvais) peux (?:plus|pu)\\b`),
        new RegExp(`\\b(?:je ne peux|je peux|j'peux|jpeux) (?:plus|pu) continuer\\b`),
        /\b(?:je |j')(?:vais |va )?craquer\b/,
        /\bje craque\b/,
        /\bau bout du rouleau\b/,
        new RegExp(`\\b${I_AM} (?:completement |vraiment )?a bout\\b`),
        new RegExp(`\\b${I_AM} (?:plus|pu) capable\\b`)
    ]
};

const DANGER: ReadonlySet<DistressCategory> = new Set(['suicide', 'harm_to_others', 'violence', 'medical_emergency']);

export function detectDistress(text: string): DistressResult {
    const normalized = normalizeForDetection(text);
    if (normalized.length === 0) return { level: 'none', categories: [] };

    const categories = (Object.keys(PATTERNS) as DistressCategory[]).filter((category) =>
        PATTERNS[category].some((pattern) => pattern.test(normalized))
    );
    if (categories.length === 0) return { level: 'none', categories };
    return { level: categories.some((c) => DANGER.has(c)) ? 'danger' : 'crisis', categories };
}
