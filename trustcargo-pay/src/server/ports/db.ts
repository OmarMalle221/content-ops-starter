/**
 * Persistence port. Services only depend on this interface.
 *
 * - `findBy` is an equality filter on top-level fields (maps to `WHERE a = $1 AND b = $2`).
 * - Ledger journals/entries, audit events and provider events are append-only by type.
 * - `UnitOfWork.run` executes the callback atomically (SQL transaction in the Postgres adapter,
 *   snapshot/rollback in the in-memory adapter). External I/O must not happen inside it.
 */
import type * as M from '@/domain/model';

export interface ReadTable<T extends { id: string }> {
    get(id: string): Promise<T | undefined>;
    findBy(where: Partial<T>): Promise<T[]>;
    findOne(where: Partial<T>): Promise<T | undefined>;
    list(options?: { limit?: number }): Promise<T[]>;
}

export interface AppendOnlyTable<T extends { id: string }> extends ReadTable<T> {
    insert(row: T): Promise<T>;
}

export interface Table<T extends { id: string }> extends AppendOnlyTable<T> {
    /** Throws ConcurrencyError if `expectedVersion` is given and does not match `row.version`. */
    update(id: string, patch: Partial<T>, options?: { expectedVersion?: number }): Promise<T>;
}

export interface Db {
    users: Table<M.User>;
    organizations: Table<M.Organization>;
    organizationMembers: Table<M.OrganizationMember>;
    identityVerifications: Table<M.IdentityVerification>;
    beneficialOwners: Table<M.BeneficialOwner>;
    paymentAccounts: Table<M.PaymentAccount>;
    sessionEvents: AppendOnlyTable<M.SessionEvent>;
    screeningResults: Table<M.ScreeningResult>;
    corridors: Table<M.Corridor>;
    transactions: Table<M.Transaction>;
    transactionParties: Table<M.TransactionParty>;
    vehicles: Table<M.Vehicle>;
    contracts: Table<M.Contract>;
    contractVersions: Table<M.ContractVersion>;
    contractAcceptances: AppendOnlyTable<M.ContractAcceptance>;
    milestones: Table<M.Milestone>;
    milestoneEvidence: Table<M.MilestoneEvidence>;
    documents: Table<M.Document>;
    documentVerifications: AppendOnlyTable<M.DocumentVerification>;
    documentAccessLogs: AppendOnlyTable<M.DocumentAccessLog>;
    riskAlerts: Table<M.RiskAlert>;
    riskReviews: AppendOnlyTable<M.RiskReview>;
    disputes: Table<M.Dispute>;
    disputeMessages: AppendOnlyTable<M.DisputeMessage>;
    disputeDecisions: AppendOnlyTable<M.DisputeDecision>;
    complianceHolds: Table<M.ComplianceHold>;
    paymentInstructions: Table<M.PaymentInstruction>;
    payouts: Table<M.Payout>;
    refunds: Table<M.Refund>;
    providerEvents: Table<M.ProviderEvent>;
    providerConnections: Table<M.ProviderConnection>;
    ledgerAccounts: Table<M.LedgerAccount>;
    ledgerJournals: AppendOnlyTable<M.LedgerJournal>;
    ledgerEntries: AppendOnlyTable<M.LedgerEntry>;
    reconciliations: AppendOnlyTable<M.Reconciliation>;
    auditEvents: AppendOnlyTable<M.AuditEvent>;
    notifications: Table<M.Notification>;
    securitySettings: Table<M.SecuritySettings & { id: string }>;
    /** Monotonic sequence (e.g. transaction references, audit chain). */
    nextSequence(name: string): Promise<number>;
}

export interface UnitOfWork {
    run<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export class ConcurrencyError extends Error {
    constructor(entity: string, id: string) {
        super(`Concurrent modification of ${entity} ${id}`);
        this.name = 'ConcurrencyError';
    }
}

export class UniqueViolationError extends Error {
    constructor(
        public readonly table: string,
        public readonly constraint: string
    ) {
        super(`Unique constraint ${constraint} violated on ${table}`);
        this.name = 'UniqueViolationError';
    }
}
