/**
 * Open-redirect guard for user-controlled "next"/"back" targets. Only same-origin relative paths are accepted:
 * no scheme, no protocol-relative `//host`, no backslash (browsers treat `/\host` as `//host`), no control
 * characters (browsers strip tabs/newlines, turning `/\t/host` into `//host`), including percent-encoded variants.
 */
const BASE = 'http://trustcargo.invalid';
const MAX_LENGTH = 1024;

function looksSafe(value: string): boolean {
    return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value);
}

export function safeRedirectPath(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return undefined;
    // Check every decoding layer (double-encoding included), not just the raw string. Malformed or
    // excessively nested encodings are refused rather than guessed at.
    let layer = raw;
    for (let depth = 0; ; depth += 1) {
        if (!looksSafe(layer)) return undefined;
        let decoded: string;
        try {
            decoded = decodeURIComponent(layer);
        } catch {
            return undefined;
        }
        if (decoded === layer) break;
        if (depth === 3) return undefined;
        layer = decoded;
    }
    let url: URL;
    try {
        url = new URL(raw, BASE);
    } catch {
        return undefined;
    }
    if (url.origin !== BASE) return undefined;
    // Dot-segments can collapse into '//' (e.g. '/.//host'): re-check the normalised result.
    const path = `${url.pathname}${url.search}${url.hash}`;
    return looksSafe(path) ? path : undefined;
}
