/** Name comparison helpers for explainable mismatch detection (no fuzzy "scores"). */

const CORPORATE_SUFFIXES = new Set(['inc', 'ltd', 'ltee', 'llc', 'sarl', 'sa', 'sas', 'suarl', 'corp', 'co', 'enr', 'senc']);

export function normalizeName(name: string): string[] {
    return name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 0 && !CORPORATE_SUFFIXES.has(t))
        .sort();
}

/** True when both names contain the same tokens (order, accents, case and legal suffixes ignored). */
export function namesMatch(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const ta = normalizeName(a);
    const tb = normalizeName(b);
    return ta.length > 0 && ta.join(' ') === tb.join(' ');
}

export function matchesAny(candidate: string | undefined, references: (string | undefined)[]): boolean {
    return references.some((r) => namesMatch(candidate, r));
}
