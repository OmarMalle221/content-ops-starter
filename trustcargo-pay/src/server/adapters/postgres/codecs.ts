/**
 * Field codecs of the Postgres adapter: how one TypeScript field maps to one or more columns.
 *
 * Every codec knows how to
 *   - select and decode its column(s) (NULL decodes to `undefined`, i.e. the key is omitted),
 *   - assign them on INSERT / UPDATE (`undefined` writes NULL, so an update can clear an optional field),
 *   - build the equality predicate of `findBy`, with the in-memory adapter's semantics (`row[k] === v`):
 *     a value that can never be stored (wrong type, non-canonical uuid or timestamp, an object or array,
 *     which memory compares by reference) yields `null` = "matches nothing" instead of a database error.
 *
 * Column names only ever come from the static table specs (tables.ts); values are always parameters.
 * Strings (text, text[] and every string of a jsonb document) go through the shared storable-text rule
 * (src/server/text.ts, also applied by the in-memory adapter): lone surrogates become U+FFFD and U+0000
 * is a VALIDATION error, so both adapters store and refuse exactly the same strings.
 */
import { isStorableString, storableString, storableValue } from '@/server/text';

export type Row = Record<string, unknown>;

/** Collects query parameters and hands out their placeholders. */
export class Params {
    readonly values: unknown[] = [];
    add(value: unknown): string {
        this.values.push(value);
        return `$${this.values.length}`;
    }
}

/**
 * A column written by a field: either a plain parameter value (`null` writes NULL) or an SQL expression.
 * Rendered only after the assignments of all fields are merged, so a column shared by two fields (two
 * Money values with one currency column) is bound once and no parameter is left unused.
 */
export type Assignment = { column: string } & ({ value: unknown; cast?: string } | { sql: (params: Params) => string });

export function renderAssignment(a: Assignment, params: Params): string {
    if ('sql' in a) return a.sql(params);
    return a.value === null ? 'null' : `${params.add(a.value)}${a.cast ?? ''}`;
}

/** Runs one statement in the unit of work's transaction. */
export type Query = (text: string, values: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;

export interface FieldCodec {
    /** SELECT-list expressions over the table alias `t`, each aliased with a key unique in the table. */
    select(): string[];
    decode(row: Row): unknown;
    /** `row` holds the sibling fields being written (insert: whole row, update: the patch). */
    assign(value: unknown, row: Row): Assignment[];
    equals(value: unknown, params: Params): string | null;
    /** Fields stored in another table (written after the main row; `replace` on update). */
    writeRelated?(query: Query, id: string, value: unknown, mode: 'insert' | 'update'): Promise<void>;
}

export class InvalidValueError extends Error {
    constructor(field: string, expected: string) {
        super(`Invalid value for ${field}: expected ${expected}`);
        this.name = 'InvalidValueError';
    }
}

const NO_MATCH = Symbol('no-match');

/* ------------------------------------------------------------------ column types */

interface ColumnType {
    /** Cast appended to an assigned placeholder (e.g. '::jsonb'). */
    assignCast?: string;
    /** Cast appended to the selected column (e.g. enum arrays read as text[]). */
    selectCast?: string;
    /** Cast appended to a filter placeholder. */
    filterCast?: string;
    /** JS → driver value. Throws on a value that cannot be stored losslessly. */
    encode(value: unknown, field: string): unknown;
    decode(value: unknown): unknown;
    /** Driver value used in an equality filter, or NO_MATCH. */
    filter(value: unknown): unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_STRING_RE = /^-?(0|[1-9]\d*)$/;

const isCanonicalTimestamp = (v: unknown): v is string => {
    if (typeof v !== 'string') return false;
    const d = new Date(v);
    return !Number.isNaN(d.getTime()) && d.toISOString() === v;
};

function scalar(check: (v: unknown) => boolean, expected: string, extra: Partial<ColumnType> = {}): ColumnType {
    return {
        encode: (v, field) => {
            if (!check(v)) throw new InvalidValueError(field, expected);
            return v;
        },
        decode: (v) => v,
        filter: (v) => (check(v) ? v : NO_MATCH),
        ...extra
    };
}

export const types = {
    text: {
        encode: (v, field) => {
            if (typeof v !== 'string') throw new InvalidValueError(field, 'a string');
            return storableString(v, field);
        },
        decode: (v) => v,
        // A string that is never stored as is matches nothing (memory compares the stored, normalised value).
        filter: (v) => (typeof v === 'string' && isStorableString(v) ? v : NO_MATCH),
        filterCast: '::text'
    } satisfies ColumnType,
    /** Canonical lowercase uuid (what the generator produces and Postgres returns). */
    uuid: scalar((v) => typeof v === 'string' && UUID_RE.test(v), 'a lowercase uuid', { filterCast: '::uuid' }),
    int: scalar((v) => Number.isInteger(v), 'an integer'),
    bool: scalar((v) => typeof v === 'boolean', 'a boolean'),
    /** int8 column holding a JS number (sizes, sequences): the pool parses int8 as bigint. */
    bigintAsNumber: {
        encode: (v, field) => {
            if (!Number.isSafeInteger(v)) throw new InvalidValueError(field, 'a safe integer');
            return String(v);
        },
        decode: (v) => (typeof v === 'bigint' ? Number(v) : v),
        filter: (v) => (Number.isSafeInteger(v) ? String(v) : NO_MATCH)
    } satisfies ColumnType,
    bigint: {
        encode: (v, field) => {
            if (typeof v !== 'bigint') throw new InvalidValueError(field, 'a bigint');
            return v.toString();
        },
        decode: (v) => v,
        filter: (v) => (typeof v === 'bigint' ? v.toString() : NO_MATCH)
    } satisfies ColumnType,
    /**
     * ISO-8601 instant. Written as Date#toISOString (UTC, so the session TimeZone never changes its meaning)
     * and read back in that exact format.
     */
    timestamptz: {
        encode: (v, field) => {
            if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new InvalidValueError(field, 'an ISO timestamp');
            return new Date(v).toISOString();
        },
        decode: (v) => (v instanceof Date ? v.toISOString() : v),
        filter: (v) => (isCanonicalTimestamp(v) ? v : NO_MATCH),
        filterCast: '::timestamptz'
    } satisfies ColumnType,
    /** Calendar date 'YYYY-MM-DD' (the pool returns `date` as the raw string: no timezone shift). */
    date: scalar((v) => typeof v === 'string' && DATE_RE.test(v), 'a YYYY-MM-DD date', { filterCast: '::date' }),
    /** Objects / arrays stored as jsonb. Memory compares them by reference, so a filter never matches. */
    json: {
        assignCast: '::jsonb',
        encode: (v, field) => {
            if (typeof v !== 'object' || v === null) throw new InvalidValueError(field, 'an object or array');
            return JSON.stringify(storableValue(v, field));
        },
        decode: (v) => v,
        filter: () => NO_MATCH
    } satisfies ColumnType,
    textArray: arrayOf('text[]'),
    enumArray: (sqlType: string) => arrayOf(`${sqlType}[]`),
    /** Enum column: a value outside the vocabulary matches nothing instead of failing the cast. */
    enumOf: (values: readonly string[]) => scalar((v) => typeof v === 'string' && values.includes(v), `one of ${values.join(', ')}`)
};

function arrayOf(sqlArrayType: string): ColumnType {
    return {
        assignCast: `::${sqlArrayType}`,
        selectCast: '::text[]',
        encode: (v, field) => {
            if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new InvalidValueError(field, 'an array of strings');
            return v.map((x: string) => storableString(x, field));
        },
        decode: (v) => v,
        filter: () => NO_MATCH
    };
}

/* ------------------------------------------------------------------ field codecs */

const alias = (key: string) => `"${key}"`;

/** One field ↔ one column. */
export function col(column: string, type: ColumnType, key = column): FieldCodec {
    return {
        select: () => [`t.${column}${type.selectCast ?? ''} as ${alias(key)}`],
        decode: (row) => {
            const v = row[key];
            return v === null || v === undefined ? undefined : type.decode(v);
        },
        assign: (value) => [
            value === undefined ? { column, value: null } : { column, value: type.encode(value, key), cast: type.assignCast }
        ],
        equals: (value, params) => {
            const v = type.filter(value);
            return v === NO_MATCH ? null : `t.${column} = ${params.add(v)}${type.filterCast ?? ''}`;
        }
    };
}

/** `col` that also fills a denormalised column computed in SQL from the same value (e.g. a parent's id). */
export function withDerived(base: FieldCodec, column: string, expression: (placeholder: string) => string): FieldCodec {
    return {
        ...base,
        assign: (value, row) => {
            const assignments = base.assign(value, row);
            const first = assignments[0]!;
            const source = 'value' in first ? first.value : null;
            return [
                ...assignments,
                source === null ? { column, value: null } : { column, sql: (params) => expression(params.add(source)) }
            ];
        }
    };
}

/** Money { amountMinor: bigint, currency } ↔ amount_minor bigint + currency (a currency column may be shared). */
export function money(amountColumn: string, currencyColumn: string, key: string): FieldCodec {
    const amount = col(amountColumn, types.bigint, `${key}$amount`);
    const currency = col(currencyColumn, types.text, `${key}$currency`);
    return {
        select: () => [...amount.select(), ...currency.select()],
        decode: (row) => {
            const a = amount.decode(row);
            const c = currency.decode(row);
            return a === undefined || c === undefined ? undefined : { amountMinor: a, currency: c };
        },
        assign: (value, row) => {
            if (value === undefined) return [...amount.assign(undefined, row), ...currency.assign(undefined, row)];
            const m = value as { amountMinor?: unknown; currency?: unknown };
            if (typeof m !== 'object' || m === null) throw new InvalidValueError(key, 'a Money value');
            return [...amount.assign(m.amountMinor, row), ...currency.assign(m.currency, row)];
        },
        equals: () => null
    };
}

/**
 * Polymorphic id (subjectId / ownerId) ↔ one nullable FK column per discriminator value. The column is
 * chosen from the discriminator being written, or, on an update that does not change it, from the row.
 */
export function polymorphicId(
    discriminatorKey: string,
    discriminatorColumn: string,
    columns: Record<string, string>,
    key: string
): FieldCodec {
    const all = Object.values(columns);
    return {
        select: () => [`coalesce(${all.map((c) => `t.${c}`).join(', ')}) as ${alias(key)}`],
        decode: (row) => row[key] ?? undefined,
        assign: (value, row): Assignment[] => {
            const id = value === undefined ? null : types.uuid.encode(value, key);
            const discriminator = row[discriminatorKey];
            if (discriminator !== undefined) {
                if (typeof discriminator !== 'string' || !(discriminator in columns))
                    throw new InvalidValueError(discriminatorKey, Object.keys(columns).join(' | '));
                return all.map((c) => ({ column: c, value: c === columns[discriminator] ? id : null }));
            }
            // Update without the discriminator: route the id with the row's current type.
            return Object.entries(columns).map(([d, c]) => ({
                column: c,
                sql: (params: Params) =>
                    id === null ? 'null' : `case when t.${discriminatorColumn} = ${params.add(d)} then ${params.add(id)}::uuid end`
            }));
        },
        equals: (value, params) => {
            const v = types.uuid.filter(value);
            if (v === NO_MATCH) return null;
            const p = params.add(v);
            return `(${all.map((c) => `t.${c} = ${p}::uuid`).join(' or ')})`;
        }
    };
}

/** Nested object whose properties live in sibling columns (Document.scan). */
export function nested(fields: Record<string, (key: string) => FieldCodec>, key: string): FieldCodec {
    const codecs = Object.entries(fields).map(([name, make]) => [name, make(`${key}$${name}`)] as const);
    return {
        select: () => codecs.flatMap(([, c]) => c.select()),
        decode: (row) => {
            const out: Row = {};
            for (const [name, c] of codecs) {
                const v = c.decode(row);
                if (v !== undefined) out[name] = v;
            }
            return Object.keys(out).length ? out : undefined;
        },
        assign: (value, row) => {
            const v = (value ?? {}) as Row;
            if (typeof v !== 'object') throw new InvalidValueError(key, 'an object');
            return codecs.flatMap(([name, c]) => c.assign(v[name], row));
        },
        equals: () => null
    };
}

/** TypeScript string id of a single-row table ↔ `id boolean primary key check (id)`. */
export function singletonId(value: string): FieldCodec {
    return {
        select: () => ['t.id as "id"'],
        decode: (row) => (row.id === true ? value : undefined),
        assign: (v) => {
            if (v !== value) throw new InvalidValueError('id', `'${value}' (single-row table)`);
            return [{ column: 'id', value: true }];
        },
        equals: (v) => (v === value ? 't.id' : null)
    };
}

export { INTEGER_STRING_RE };
