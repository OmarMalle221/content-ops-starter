// Garde-fous appliqués à la sortie du modèle, AVANT tout affichage (règles non négociables 1 et 3).
//
// Principe : le modèle résume ce qui est écrit. Tout ce qui ne se retrouve pas dans le document est
// retiré ou marqué « à vérifier » :
// - formulation de conseil ou d'interprétation absente du document (« vous devriez », « augmenter la
//   dose », « normal », « inquiétant »…) ;
// - chiffre absent du document (dose, quantité, date) ;
// - médicament, dose, fréquence ou ligne d'origine introuvables tels quels ;
// - date qui ne correspond à rien d'écrit.
// Les vérifications portent sur le texte pseudonymisé (celui que le modèle a lu) ; la ré-identification
// locale vient ensuite.
import { fold, reidentify, type PseudonymEntry } from '../pseudonymize/pseudonymize.ts';
import { DOCUMENT_TYPE_LABELS } from './labels.fr.ts';
import { EXTRACTION_SCHEMA_VERSION, LIMITS, type ExtractionDraft, type GuardFlag, type ModelOutput, type ReviewReason } from './schema.ts';

const TOKEN = /\[[A-Z_]+_\d+\]/g;

/** Texte comparable : sans accents, minuscules, ponctuation réduite à des espaces, jetons conservés. */
export function comparable(value: string): string {
    return fold(value)
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/(\d)(\p{L})/gu, '$1 $2')
        .replace(/(\p{L})(\d)/gu, '$1 $2')
        .replace(/[^\p{L}\p{N}[\]_.]+/gu, ' ')
        .replace(/\.(?!\d)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function numbersIn(value: string): string[] {
    return comparable(value.replace(TOKEN, ' ')).match(/\d+(?:\.\d+)?/g) ?? [];
}

// Conseil, consigne ou interprétation (sur du texte replié : sans accents, minuscules).
const ADVICE_PATTERNS: RegExp[] = [
    /\bvous devr(?:iez|ez|ait)\b/,
    /\bil (?:vous )?faudr(?:ait|a)\b/,
    /\bil faut\b/,
    /\b(?:je|nous) (?:vous )?(?:recommande|recommandons|conseille|conseillons|suggere|suggerons)\b/,
    /\b(?:est |sont )?(?:recommande|conseille|deconseille)e?s? de\b/,
    /\b(?:augmenter|diminuer|reduire|arreter|cesser|doubler|sauter|modifier|changer|ajuster) (?:la |le |les |sa |son |ses |cette |ce |votre |vos )?(?:dose|doses|dosage|medicament|medicaments|traitement|prise|posologie)\b/,
    /\b(?:aucune? |pas d'|pas de |sans )(?:inquietude|souci|danger|risque)s?\b/,
    /\b(?:rien de grave|pas grave|grave)\b/,
    /\b(?:inquietant|rassurant|alarmant|preoccupant|encourageant)e?s?\b/,
    /\b(?:anormale?s?|anormaux|normale?s?|normaux)\b/,
    /\b(?:bon|mauvais) signe\b/,
    /\b(?:s'ameliore|se deteriore|s'aggrave|empire)\b/,
    /\bdiagnosti(?:c|que|quer)\b/,
    /\b(?:consultez|appelez|prenez|evitez|surveillez)\b/
];

const MONTHS: Record<number, string[]> = {
    1: ['janvier', 'janv'],
    2: ['fevrier', 'fevr', 'fev'],
    3: ['mars'],
    4: ['avril', 'avr'],
    5: ['mai'],
    6: ['juin'],
    7: ['juillet', 'juil'],
    8: ['aout'],
    9: ['septembre', 'sept'],
    10: ['octobre', 'oct'],
    11: ['novembre', 'nov'],
    12: ['decembre', 'dec']
};

class SourceIndex {
    readonly text: string;
    readonly numbers: Set<string>;
    readonly words: Set<string>;

    constructor(source: string) {
        this.text = ` ${comparable(source)} `;
        this.numbers = new Set(numbersIn(source).flatMap((n) => [n, String(Number(n))]));
        this.words = new Set(this.text.split(' ').filter(Boolean));
    }

    contains(fragment: string): boolean {
        const c = comparable(fragment);
        return c.length === 0 || this.text.includes(` ${c} `);
    }

    numbersSupported(value: string): boolean {
        return numbersIn(value).every((n) => this.numbers.has(n) || this.numbers.has(String(Number(n))));
    }

    /** Vrai si la date ISO correspond à ce qui est écrit (année, jour, et mois en chiffres ou en lettres). */
    dateSupported(iso: string): boolean {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!match) return false;
        const [, y, m, d] = match as unknown as [string, string, string, string];
        const date = new Date(`${iso}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return false;
        const month = Number(m);
        const yearOk = this.numbers.has(y) || this.numbers.has(y.slice(2));
        const dayOk = this.numbers.has(String(Number(d)));
        const monthOk = this.numbers.has(String(month)) || (MONTHS[month] ?? []).some((name) => this.words.has(name));
        return yearOk && dayOk && monthOk;
    }

    /** Formulations de conseil ou d'interprétation absentes du document. */
    adviceNotInSource(value: string): boolean {
        const folded = fold(value);
        return ADVICE_PATTERNS.some((pattern) => {
            const found = new RegExp(pattern.source, 'g');
            for (const m of folded.matchAll(found)) {
                if (!this.text.includes(comparable(m[0]))) return true;
            }
            return false;
        });
    }
}

const clip = (value: string, max: number): { value: string; clipped: boolean } => {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return { value: clean, clipped: false };
    const cut = clean.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return { value: `${space > max * 0.6 ? cut.slice(0, space) : cut}…`, clipped: true };
};

export interface GuardResult {
    draft: ExtractionDraft;
    /** Le brouillon a-t-il été modifié ou marqué par un garde-fou ? (pour ai_calls.status) */
    flagged: boolean;
}

/**
 * Applique les garde-fous à la sortie du modèle (texte pseudonymisé), puis ré-identifie localement.
 * @param source texte pseudonymisé envoyé au modèle
 */
export function guardAndRestore(output: ModelOutput, source: string, mapping: Map<string, PseudonymEntry>): GuardResult {
    const index = new SourceIndex(source);
    const flags = new Set<GuardFlag>();
    const reasons = new Set<ReviewReason>(output.review_reasons);

    // Ré-identification et longueur maximale d'un champ.
    const restore = (value: string, max: number): string => {
        const { text, unknownTokens } = reidentify(value, mapping);
        if (unknownTokens > 0) flags.add('unknown_token');
        const clipped = clip(text, max);
        if (clipped.clipped) flags.add('truncated');
        return clipped.value;
    };
    const restoreOrNull = (value: string | null, max: number) => (value === null || value.trim() === '' ? null : restore(value, max));

    // Un champ rédigé par le modèle : pas de conseil, pas de chiffre inventé.
    const authored = (value: string): boolean => {
        let ok = true;
        if (index.adviceNotInSource(value)) {
            flags.add('advice_language');
            ok = false;
        }
        if (!index.numbersSupported(value)) {
            flags.add('invented_number');
            ok = false;
        }
        return ok;
    };
    // Un champ recopié du document : doit s'y retrouver tel quel.
    const copied = (value: string | null): boolean => {
        if (value === null || value.trim() === '') return true;
        if (index.contains(value)) return true;
        flags.add('not_in_source');
        return false;
    };
    const dateOk = (value: string | null): boolean => {
        if (value === null) return true;
        if (index.dateSupported(value)) return true;
        reasons.add('ambiguous_date');
        return false;
    };
    const markUnverified = (ok: boolean) => {
        if (!ok) reasons.add('not_in_source');
        return !ok;
    };

    // Document
    const documentDate = output.document_date !== null && dateOk(output.document_date) ? output.document_date : null;
    const fallbackTitle = DOCUMENT_TYPE_LABELS[output.document_type];
    const title = output.title.trim() !== '' && authored(output.title) ? restore(output.title, LIMITS.title) : fallbackTitle;
    const authorWordsOk =
        output.author === null ||
        comparable(output.author.replace(TOKEN, ' '))
            .split(' ')
            .filter((w) => w.length >= 4)
            .every((w) => index.words.has(w));
    const author = output.author !== null && authorWordsOk && authored(output.author) ? restore(output.author, LIMITS.author) : null;
    if (output.author !== null && author === null) reasons.add('not_in_source');

    let summary: string | null = null;
    if (output.plain_summary.trim() !== '') {
        if (authored(output.plain_summary)) summary = restore(output.plain_summary, LIMITS.summary + 1);
        else reasons.add('summary_removed');
    }

    const take = <T>(items: T[]): T[] => {
        if (items.length > LIMITS.items) flags.add('truncated');
        return items.slice(0, LIMITS.items);
    };

    const medications = take(output.medications_as_written)
        .filter((m) => m.name.trim() !== '')
        .map((m) => {
            const ok = [copied(m.name), copied(m.dosage), copied(m.frequency), copied(m.source_line)].every(Boolean);
            return {
                name: restore(m.name, LIMITS.field),
                dosage: restoreOrNull(m.dosage, LIMITS.field),
                frequency: restoreOrNull(m.frequency, LIMITS.field),
                source_line: restore(m.source_line, LIMITS.sourceLine),
                unverified: markUnverified(ok)
            };
        });

    const appointments = take(output.appointments).map((a) => {
        const ok = [dateOk(a.date), copied(a.time), copied(a.place), authored(a.purpose), copied(a.source_line)].every(Boolean);
        return {
            date: a.date !== null && index.dateSupported(a.date) ? a.date : null,
            time: restoreOrNull(a.time, 40),
            place: restoreOrNull(a.place, LIMITS.item),
            purpose: restore(a.purpose, LIMITS.item),
            source_line: restore(a.source_line, LIMITS.sourceLine),
            unverified: markUnverified(ok)
        };
    });

    const actionItems = take(output.action_items)
        .filter((a) => a.text.trim() !== '')
        .map((a) => {
            const ok = [authored(a.text), copied(a.source_line)].every(Boolean);
            return {
                text: restore(a.text, LIMITS.item),
                source_line: restore(a.source_line, LIMITS.sourceLine),
                unverified: markUnverified(ok)
            };
        });

    const timelineEvents = take(output.timeline_events)
        .filter((e) => e.title.trim() !== '')
        .map((e) => {
            const ok = [dateOk(e.date), authored(e.title), copied(e.source_line)].every(Boolean);
            return {
                date: e.date !== null && index.dateSupported(e.date) ? e.date : null,
                event_type: e.event_type,
                title: restore(e.title, LIMITS.title),
                source_line: restore(e.source_line, LIMITS.sourceLine),
                unverified: markUnverified(ok)
            };
        });

    if (output.legibility === 'handwritten') reasons.add('handwriting');
    if (output.legibility === 'blurry') reasons.add('blurry');
    if (output.legibility === 'partial') reasons.add('partial_text');

    const guardFlags = [...flags];
    const reviewReasons = [...reasons];
    const draft: ExtractionDraft = {
        schema_version: EXTRACTION_SCHEMA_VERSION,
        document_type: output.document_type,
        document_date: documentDate,
        author,
        title,
        plain_summary: summary,
        medications,
        appointments,
        action_items: actionItems,
        timeline_events: timelineEvents,
        legibility: output.legibility,
        needs_review: output.needs_review || output.legibility !== 'clear' || guardFlags.length > 0 || reviewReasons.length > 0,
        review_reasons: reviewReasons,
        guard_flags: guardFlags
    };
    return { draft, flagged: guardFlags.length > 0 };
}
