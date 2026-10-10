/**
 * Generic table over a declarative spec (tables.ts), with the semantics of the in-memory MemoryTable:
 *
 * - get / findBy (top-level equality, `undefined` values ignored) / findOne / list({ limit }), ordered by
 *   id. Ids are UUIDv7, so id order is creation order — the order in which memory returns rows.
 * - insert returns a copy of the given row; update merges the patch (a key present with `undefined`
 *   clears the column), throws on an unknown id, honours `expectedVersion` (ConcurrencyError) and bumps
 *   transactions.version by exactly 1.
 * - unique violations (SQLSTATE 23505) surface as UniqueViolationError(table, constraint).
 * - a field that is not in the spec cannot be written (it would be silently lost otherwise).
 */
import { ConcurrencyError, UniqueViolationError } from '@/server/ports/db';
import { InvalidValueError, Params, renderAssignment, type Assignment, type FieldCodec, type Query, type Row } from './codecs';

export interface TableSpec {
    /** Db port key, e.g. 'transactionParties' (used in error messages, like the memory adapter). */
    name: string;
    /** Schema-qualified table, e.g. 'trustcargo.transaction_parties'. */
    table: string;
    fields: Record<string, FieldCodec>;
    /** No update method (same set as the memory adapter). */
    appendOnly?: boolean;
    /** `version` is an optimistic-lock counter incremented by exactly 1 on every update. */
    versioned?: boolean;
    /** Single-row table: insert updates the existing row (security_settings). */
    upsert?: boolean;
}

function uniqueViolation(spec: TableSpec, error: unknown): unknown {
    const e = error as { code?: string; constraint?: string };
    if (e?.code !== '23505') return error;
    const constraint = e.constraint ?? 'unknown';
    return new UniqueViolationError(spec.name, constraint === `${spec.table.split('.')[1]}_pkey` ? 'id' : constraint);
}

export class PgTable<T extends { id: string }> {
    private readonly selectList: string;

    constructor(
        protected readonly spec: TableSpec,
        protected readonly query: Query
    ) {
        this.selectList = Object.values(spec.fields)
            .flatMap((f) => f.select())
            .join(', ');
    }

    protected decode(row: Row): T {
        const out: Row = {};
        for (const [key, codec] of Object.entries(this.spec.fields)) {
            const v = codec.decode(row);
            if (v !== undefined) out[key] = v;
        }
        return out as T;
    }

    /** Equality predicates for `where`, or null when one of them can never match. */
    protected predicates(where: Row, params: Params): string[] | null {
        const out: string[] = [];
        for (const [key, value] of Object.entries(where)) {
            if (value === undefined) continue;
            const codec = this.spec.fields[key];
            const predicate = codec ? codec.equals(value, params) : null;
            if (predicate === null) return null;
            out.push(predicate);
        }
        return out;
    }

    protected async select(where: Row, limit?: number): Promise<T[]> {
        const params = new Params();
        const predicates = this.predicates(where, params);
        if (predicates === null) return [];
        const sql =
            `select ${this.selectList} from ${this.spec.table} t` +
            (predicates.length ? ` where ${predicates.join(' and ')}` : '') +
            ' order by t.id' +
            (limit ? ` limit ${params.add(limit)}` : '');
        const result = await this.query(sql, params.values);
        return result.rows.map((r) => this.decode(r));
    }

    async get(id: string): Promise<T | undefined> {
        return (await this.select({ id }, 1))[0];
    }

    async findBy(where: Partial<T>): Promise<T[]> {
        return this.select(where as Row);
    }

    async findOne(where: Partial<T>): Promise<T | undefined> {
        return (await this.select(where as Row, 1))[0];
    }

    async list(options?: { limit?: number }): Promise<T[]> {
        return this.select({}, options?.limit || undefined);
    }

    protected codecFor(key: string): FieldCodec {
        const codec = this.spec.fields[key];
        if (!codec) throw new InvalidValueError(`${this.spec.name}.${key}`, 'a field of the table (unknown field)');
        return codec;
    }

    async insert(row: T): Promise<T> {
        const values = row as unknown as Row;
        for (const [key, v] of Object.entries(values)) if (v !== undefined) this.codecFor(key);
        const params = new Params();
        const assignments: Assignment[] = [];
        const related: [FieldCodec, unknown][] = [];
        for (const [key, codec] of Object.entries(this.spec.fields)) {
            if (codec.writeRelated) related.push([codec, values[key]]);
            else assignments.push(...codec.assign(values[key], values));
        }
        const columns = mergeAssignments(this.spec.name, assignments);
        const rendered = columns.map((a) => renderAssignment(a, params));
        const sql =
            `insert into ${this.spec.table} (${columns.map((a) => a.column).join(', ')}) values (${rendered.join(', ')})` +
            (this.spec.upsert
                ? ` on conflict (id) do update set ${columns
                      .filter((a) => a.column !== 'id')
                      .map((a) => `${a.column} = excluded.${a.column}`)
                      .join(', ')}`
                : '');
        try {
            await this.query(sql, params.values);
            for (const [codec, value] of related) await codec.writeRelated!(this.query, row.id, value, 'insert');
        } catch (error) {
            throw uniqueViolation(this.spec, error);
        }
        return structuredClone(row);
    }
}

export class PgMutableTable<T extends { id: string }> extends PgTable<T> {
    async update(id: string, patch: Partial<T>, options?: { expectedVersion?: number }): Promise<T> {
        const values = patch as Row;
        const params = new Params();
        const idPredicate = this.spec.fields.id!.equals(id, params);
        if (idPredicate === null) throw new Error(`${this.spec.name} ${id} not found`);
        const predicates = [idPredicate];
        if (options?.expectedVersion !== undefined) {
            const versionPredicate = this.spec.fields.version?.equals(options.expectedVersion, params) ?? null;
            predicates.push(versionPredicate ?? 'false');
        }

        const assignments: Assignment[] = [];
        const related: [FieldCodec, unknown][] = [];
        for (const [key, value] of Object.entries(values)) {
            if (key === 'id' || (this.spec.versioned && key === 'version')) continue;
            if (value === undefined && !this.spec.fields[key]) continue;
            const codec = this.codecFor(key);
            if (codec.writeRelated) related.push([codec, value]);
            else assignments.push(...codec.assign(value, values));
        }
        const sets = mergeAssignments(this.spec.name, assignments).map((a) => `${a.column} = ${renderAssignment(a, params)}`);
        if (this.spec.versioned) sets.push('version = t.version + 1');
        if (!sets.length) sets.push('id = t.id');

        try {
            const result = await this.query(
                `update ${this.spec.table} as t set ${sets.join(', ')} where ${predicates.join(' and ')} returning t.id`,
                params.values
            );
            if (!result.rowCount) {
                if (!(await this.get(id))) throw new Error(`${this.spec.name} ${id} not found`);
                throw new ConcurrencyError(this.spec.name, id);
            }
            for (const [codec, value] of related) await codec.writeRelated!(this.query, id, value, 'update');
        } catch (error) {
            throw uniqueViolation(this.spec, error);
        }
        return (await this.get(id))!;
    }
}

/** Two fields may write the same column (two Money fields sharing one currency): their values must agree. */
function mergeAssignments(table: string, assignments: Assignment[]): Assignment[] {
    const byColumn = new Map<string, Assignment>();
    for (const a of assignments) {
        const existing = byColumn.get(a.column);
        if (!existing) byColumn.set(a.column, a);
        else if (!('value' in a) || !('value' in existing) || existing.value !== a.value || existing.cast !== a.cast)
            throw new InvalidValueError(`${table}.${a.column}`, 'the same value from every field that writes it');
    }
    return [...byColumn.values()];
}
