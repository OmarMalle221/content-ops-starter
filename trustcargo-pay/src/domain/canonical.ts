/** Deterministic JSON serialisation (sorted keys, bigint as string) used for hashing. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') return JSON.stringify(value.toString());
        if (value === undefined) return 'null';
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
