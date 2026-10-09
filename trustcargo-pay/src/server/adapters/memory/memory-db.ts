/**
 * In-memory persistence adapter (demo + tests).
 *
 * - Serialises units of work with a promise-chain mutex and rolls back on error by restoring a
 *   structured-clone snapshot — atomicity semantics comparable to an SQL transaction.
 * - Enforces the same unique constraints and append-only rules as the SQL schema.
 * - Rows are cloned on read and write so callers can never mutate stored state by reference.
 *
 * Limitation: state is per-process and lost on restart. Not suitable for multi-instance or
 * serverless deployments (each instance would hold different data).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConcurrencyError, UniqueViolationError, type AppendOnlyTable, type Db, type Table, type UnitOfWork } from '@/server/ports/db';

type Row = { id: string } & Record<string, unknown>;
type State = { tables: Record<string, Map<string, Row>>; sequences: Record<string, number> };

const UNIQUE: Record<string, string[][]> = {
    users: [['email']],
    transactions: [['reference']],
    contractVersions: [['transactionId', 'versionNumber']],
    contractAcceptances: [['contractVersionId', 'partyId']],
    documents: [['logicalId', 'version']],
    ledgerAccounts: [['code']],
    ledgerJournals: [['idempotencyKey']],
    providerEvents: [['provider', 'externalEventId']],
    paymentInstructions: [['idempotencyKey']],
    payouts: [['idempotencyKey']],
    refunds: [['idempotencyKey']],
    riskAlerts: [['fingerprint']],
    organizationMembers: [['organizationId', 'userId']],
    milestoneEvidence: [['milestoneId', 'documentId']]
};

const APPEND_ONLY = new Set([
    'sessionEvents',
    'contractAcceptances',
    'documentVerifications',
    'documentAccessLogs',
    'riskReviews',
    'disputeMessages',
    'disputeDecisions',
    'ledgerJournals',
    'ledgerEntries',
    'reconciliations',
    'auditEvents'
]);

const TABLE_NAMES = [
    'users',
    'organizations',
    'organizationMembers',
    'identityVerifications',
    'beneficialOwners',
    'paymentAccounts',
    'sessionEvents',
    'screeningResults',
    'corridors',
    'transactions',
    'transactionParties',
    'vehicles',
    'contracts',
    'contractVersions',
    'contractAcceptances',
    'milestones',
    'milestoneEvidence',
    'documents',
    'documentVerifications',
    'documentAccessLogs',
    'riskAlerts',
    'riskReviews',
    'disputes',
    'disputeMessages',
    'disputeDecisions',
    'complianceHolds',
    'paymentInstructions',
    'payouts',
    'refunds',
    'providerEvents',
    'providerConnections',
    'ledgerAccounts',
    'ledgerJournals',
    'ledgerEntries',
    'reconciliations',
    'auditEvents',
    'notifications',
    'securitySettings'
] as const;

const clone = <T>(v: T): T => structuredClone(v);

function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
}

class MemoryTable implements Table<Row> {
    constructor(
        private readonly name: string,
        private readonly state: () => State
    ) {}

    private get rows(): Map<string, Row> {
        return this.state().tables[this.name]!;
    }

    async get(id: string) {
        const row = this.rows.get(id);
        return row ? clone(row) : undefined;
    }

    async findBy(where: Partial<Row>) {
        return [...this.rows.values()].filter((r) => matches(r, where)).map(clone);
    }

    async findOne(where: Partial<Row>) {
        return (await this.findBy(where))[0];
    }

    async list(options?: { limit?: number }) {
        const all = [...this.rows.values()].map(clone);
        return options?.limit ? all.slice(0, options.limit) : all;
    }

    private checkUnique(row: Row, excludeId?: string) {
        for (const cols of UNIQUE[this.name] ?? []) {
            for (const other of this.rows.values()) {
                if (other.id === excludeId) continue;
                if (cols.every((c) => row[c] !== undefined && other[c] === row[c])) {
                    throw new UniqueViolationError(this.name, cols.join('+'));
                }
            }
        }
    }

    async insert(row: Row) {
        if (this.rows.has(row.id)) throw new UniqueViolationError(this.name, 'id');
        this.checkUnique(row);
        this.rows.set(row.id, clone(row));
        return clone(row);
    }

    async update(id: string, patch: Partial<Row>, options?: { expectedVersion?: number }) {
        if (APPEND_ONLY.has(this.name)) throw new Error(`${this.name} is append-only`);
        const current = this.rows.get(id);
        if (!current) throw new Error(`${this.name} ${id} not found`);
        if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
            throw new ConcurrencyError(this.name, id);
        }
        const next: Row = { ...current, ...clone(patch), id };
        if (typeof current.version === 'number' && this.name === 'transactions') next.version = (current.version as number) + 1;
        this.checkUnique(next, id);
        this.rows.set(id, next);
        return clone(next);
    }
}

export class MemoryDatabase implements UnitOfWork {
    private state: State;
    private queue: Promise<unknown> = Promise.resolve();
    /** Tracks whether the current async context is already inside a unit of work. */
    private readonly context = new AsyncLocalStorage<true>();
    readonly db: Db;

    constructor() {
        this.state = { tables: Object.fromEntries(TABLE_NAMES.map((n) => [n, new Map()])), sequences: {} };
        const tables = Object.fromEntries(TABLE_NAMES.map((n) => [n, new MemoryTable(n, () => this.state)]));
        this.db = {
            ...(tables as unknown as Omit<Db, 'nextSequence'>),
            nextSequence: async (name: string) => {
                this.state.sequences[name] = (this.state.sequences[name] ?? 0) + 1;
                return this.state.sequences[name]!;
            }
        };
        for (const name of APPEND_ONLY) {
            const table = (this.db as unknown as Record<string, Partial<Table<Row>>>)[name]!;
            (table as { update?: unknown }).update = undefined;
        }
    }

    run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
        if (this.context.getStore()) {
            // Nested call from inside a unit of work (same async context): join the outer transaction.
            return fn(this.db);
        }
        const execute = async () => {
            const snapshot = clone(this.state);
            try {
                return await this.context.run(true, () => fn(this.db));
            } catch (error) {
                this.state = snapshot;
                throw error;
            }
        };
        const result = this.queue.then(execute, execute);
        this.queue = result.catch(() => undefined);
        return result;
    }
}

export type { AppendOnlyTable };
