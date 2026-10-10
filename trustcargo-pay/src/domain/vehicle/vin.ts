/**
 * Local, structural VIN checks (ISO 3779 / 49 CFR 565).
 *
 * IMPORTANT: a structurally valid VIN proves nothing about theft, liens, ownership or history.
 * These checks only detect typos and obviously malformed identifiers. Theft / lien / title checks
 * must come from authorised data providers (see VehicleHistoryProvider port).
 */

const TRANSLITERATION: Record<string, number> = {
    A: 1,
    B: 2,
    C: 3,
    D: 4,
    E: 5,
    F: 6,
    G: 7,
    H: 8,
    J: 1,
    K: 2,
    L: 3,
    M: 4,
    N: 5,
    P: 7,
    R: 9,
    S: 2,
    T: 3,
    U: 4,
    V: 5,
    W: 6,
    X: 7,
    Y: 8,
    Z: 9
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** World Manufacturer Identifier first characters assigned to North America (check digit is mandatory there). */
const NORTH_AMERICA_REGION = /^[1-5]/;

export type VinIssue = 'LENGTH' | 'FORBIDDEN_CHARACTERS' | 'INVALID_CHARACTERS' | 'CHECK_DIGIT_MISMATCH';

export interface VinCheckResult {
    normalized: string;
    structurallyValid: boolean;
    issues: VinIssue[];
    /** Whether the position-9 check digit is mandatory for this region and was evaluated. */
    checkDigitEvaluated: boolean;
    expectedCheckDigit?: string;
}

export function normalizeVin(raw: string): string {
    return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function computeCheckDigit(vin: string): string | null {
    if (vin.length !== 17) return null;
    let total = 0;
    for (let i = 0; i < 17; i++) {
        const ch = vin[i]!;
        const value = /\d/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
        if (value === undefined) return null;
        total += value * WEIGHTS[i]!;
    }
    const remainder = total % 11;
    return remainder === 10 ? 'X' : String(remainder);
}

export function checkVin(raw: string): VinCheckResult {
    const normalized = normalizeVin(raw);
    const issues: VinIssue[] = [];
    if (normalized.length !== 17) issues.push('LENGTH');
    if (/[IOQ]/.test(normalized)) issues.push('FORBIDDEN_CHARACTERS');
    if (/[^A-Z0-9]/.test(normalized)) issues.push('INVALID_CHARACTERS');

    let checkDigitEvaluated = false;
    let expectedCheckDigit: string | undefined;
    if (issues.length === 0 && NORTH_AMERICA_REGION.test(normalized)) {
        checkDigitEvaluated = true;
        expectedCheckDigit = computeCheckDigit(normalized) ?? undefined;
        if (expectedCheckDigit !== normalized[8]) issues.push('CHECK_DIGIT_MISMATCH');
    }
    return { normalized, structurallyValid: issues.length === 0, issues, checkDigitEvaluated, expectedCheckDigit };
}
