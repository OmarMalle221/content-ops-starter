/**
 * Text that every persistence adapter stores the same way.
 *
 * PostgreSQL text and jsonb hold well-formed Unicode without U+0000: jsonb rejects a lone UTF-16 surrogate
 * (22P02), text columns silently turn it into U+FFFD, and both reject U+0000 (22021 / 22P05). JavaScript
 * strings may contain all of these, so:
 *   - both adapters pass every stored string through `storableString` / `storableValue` (lone surrogates
 *     become U+FFFD, U+0000 is a VALIDATION error), in memory exactly as on Postgres;
 *   - services cut user text with `truncateText`, on code points, never inside a surrogate pair.
 */
import { AppError } from './errors';

/** The first `max` code points of `text` (an emoji is kept whole or dropped, never cut in half). */
export function truncateText(text: string, max: number): string {
    if (text.length <= max) return text; // a code point is 1 or 2 UTF-16 units
    let count = 0;
    let end = 0;
    for (const codePoint of text) {
        if (count === max) break;
        count += 1;
        end += codePoint.length;
    }
    return text.slice(0, end);
}

/** True when `value` is stored unchanged by every adapter. */
export function isStorableString(value: string): boolean {
    return value.isWellFormed() && !value.includes('\u0000');
}

/** `value` as stored: lone surrogates replaced by U+FFFD; U+0000 refused (VALIDATION). */
export function storableString(value: string, field: string): string {
    if (value.includes('\u0000')) throw new AppError('VALIDATION', 'Text cannot contain the NUL character (U+0000)', { field });
    return value.isWellFormed() ? value : value.toWellFormed();
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

/** `value` with every string made storable, object keys included (JSON documents); other values are kept. */
export function storableValue<T>(value: T, field: string): T {
    if (typeof value === 'string') return storableString(value, field) as T;
    if (Array.isArray(value)) return value.map((item) => storableValue(item, field)) as T;
    if (isPlainObject(value))
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [storableString(k, field), storableValue(v, field)])) as T;
    return value;
}
