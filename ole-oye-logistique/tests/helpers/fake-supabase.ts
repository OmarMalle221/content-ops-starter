/**
 * Faux Supabase en mémoire pour les tests : remplace `netlify/lib/supabase`.
 * Il imite la petite partie du client utilisée par les fonctions, ainsi que
 * les règles du schéma SQL (contraintes, valeurs par défaut, déclencheur de
 * statut, limite de débit). La migration elle-même se vérifie sur Postgres.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;
type Result = { data: any; error: { message: string; code?: string } | null };

export const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

export class NotConfiguredError extends Error {}

export const db = {
  tables: {} as Record<string, Row[]>,
  quoteSequence: 1001,
  rateHits: new Map<string, number>(),
  /** Courriels auxquels un lien de connexion a été « envoyé ». */
  sentOtps: [] as string[],
  /** Code accepté par `verifyOtp`. */
  otpCode: '123456',
  clock: 0,
};

export function resetDb(): void {
  db.tables = { quote_requests: [], shipments: [], shipment_events: [], admin_users: [], rate_limits: [] };
  db.quoteSequence = 1001;
  db.rateHits.clear();
  db.sentOtps = [];
  db.clock = 0;
}
resetDb();

/** Horloge de la « base » : strictement croissante, pour un ordre d'insertion déterministe. */
function now(): string {
  db.clock = Math.max(db.clock + 1, Date.now());
  return new Date(db.clock).toISOString();
}

function syncStatus(shipmentId: string): void {
  const shipment = db.tables.shipments.find((row) => row.id === shipmentId);
  if (!shipment) return;
  const latest = db.tables.shipment_events
    .filter((event) => event.shipment_id === shipmentId)
    .sort((a, b) => (a.occurred_at + a.created_at < b.occurred_at + b.created_at ? 1 : -1))[0];
  if (latest) shipment.current_status = latest.status;
  shipment.updated_at = now();
}

function insertRow(table: string, input: Row): Result {
  const row: Row = { id: randomUUID(), created_at: now(), ...input };
  if (table === 'quote_requests') {
    if (row.consent_given !== true) return { data: null, error: { message: 'consent_given check', code: '23514' } };
    row.reference = `DV-26-${String(db.quoteSequence++).padStart(5, '0')}`;
    row.status = 'new';
  }
  if (table === 'shipments') {
    const duplicate = db.tables.shipments.some((s) => s.tenant_id === row.tenant_id && s.reference === row.reference);
    if (duplicate) return { data: null, error: { message: 'duplicate key', code: '23505' } };
    row.current_status ??= 'received_at_warehouse';
    row.updated_at = row.created_at;
  }
  if (table === 'shipment_events') {
    row.occurred_at ??= now();
    row.source ??= 'manual';
  }
  db.tables[table].push(row);
  if (table === 'shipment_events') syncStatus(row.shipment_id);
  return { data: row, error: null };
}

type Filter = (row: Row) => boolean;

function parseOr(expression: string): Filter {
  const conditions = expression.split(',').map((part) => {
    const [column, operator, ...rest] = part.split('.');
    const value = rest.join('.');
    if (operator === 'eq') return (row: Row) => String(row[column] ?? '') === value && row[column] != null;
    if (operator === 'ilike') {
      const needle = value.replace(/[*%]/g, '').toLowerCase();
      return (row: Row) => row[column] != null && String(row[column]).toLowerCase().includes(needle);
    }
    throw new Error(`faux Supabase : opérateur non géré « ${operator} »`);
  });
  return (row) => conditions.some((condition) => condition(row));
}

class Query implements PromiseLike<Result> {
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private columns = '*';
  private payload: Row = {};
  private filters: Filter[] = [];
  private sort: { column: string; ascending: boolean }[] = [];
  private max: number | null = null;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private table: string) {
    if (!db.tables[table]) throw new Error(`faux Supabase : table inconnue « ${table} »`);
  }

  select(columns = '*') {
    this.columns = columns;
    return this;
  }
  insert(row: Row) {
    this.operation = 'insert';
    this.payload = row;
    return this;
  }
  update(changes: Row) {
    this.operation = 'update';
    this.payload = changes;
    return this;
  }
  delete() {
    this.operation = 'delete';
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => String(row[column]).toLowerCase() === String(value).toLowerCase());
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  or(expression: string) {
    this.filters.push(parseOr(expression));
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.sort.push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybeSingle';
    return this;
  }

  private project(row: Row): Row {
    if (this.columns.trim() === '*') return { ...row };
    return Object.fromEntries(this.columns.split(',').map((column) => [column.trim(), row[column.trim()] ?? null]));
  }

  private execute(): Result {
    const rows = db.tables[this.table];
    let selected: Row[];

    if (this.operation === 'insert') {
      const result = insertRow(this.table, this.payload);
      if (result.error) return result;
      selected = [result.data];
    } else {
      selected = rows.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.operation === 'update') selected.forEach((row) => Object.assign(row, this.payload));
      if (this.operation === 'delete') {
        db.tables[this.table] = rows.filter((row) => !selected.includes(row));
        if (this.table === 'shipment_events') selected.forEach((event) => syncStatus(event.shipment_id));
      }
      for (const { column, ascending } of [...this.sort].reverse()) {
        selected = [...selected].sort((a, b) => (a[column] === b[column] ? 0 : (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1)));
      }
      if (this.max !== null) selected = selected.slice(0, this.max);
    }

    const data = selected.map((row) => this.project(row));
    if (this.mode === 'many') return { data, error: null };
    if (data.length === 0) {
      return this.mode === 'single' ? { data: null, error: { message: 'no rows', code: 'PGRST116' } } : { data: null, error: null };
    }
    return { data: data[0], error: null };
  }

  then<A = Result, B = never>(
    resolve?: ((value: Result) => A | PromiseLike<A>) | null,
    reject?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(resolve, reject);
  }
}

function fakeClient() {
  return {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Row): Promise<Result> => {
      if (name !== 'check_rate_limit') return { data: null, error: { message: `rpc inconnue ${name}` } };
      const key = `${args.p_bucket}:${args.p_key_hash}`;
      const hits = (db.rateHits.get(key) ?? 0) + 1;
      db.rateHits.set(key, hits);
      return { data: hits <= args.p_max, error: null };
    },
    auth: {
      signInWithOtp: async ({ email }: { email: string }) => {
        db.sentOtps.push(email);
        return { data: {}, error: null };
      },
      verifyOtp: async ({ email, token }: { email: string; token: string }) =>
        token === db.otpCode
          ? { data: { user: { email } }, error: null }
          : { data: { user: null }, error: { message: 'Token has expired or is invalid' } },
      getUser: async (token: string) =>
        token.startsWith('valid-token:')
          ? { data: { user: { email: token.slice('valid-token:'.length) } }, error: null }
          : { data: { user: null }, error: { message: 'invalid JWT' } },
    },
  };
}

export const serviceClient = () => fakeClient();
export const authClient = () => fakeClient();
export const tenantId = () => TEST_TENANT;
