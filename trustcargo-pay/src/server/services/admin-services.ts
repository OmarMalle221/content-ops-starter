import { canonicalJson } from '@/domain/canonical';
import { parseMoney, type CurrencyCode } from '@/domain/money';
import type { AuditEvent, Reconciliation, ReconciliationItem } from '@/domain/model';
import { complianceHoldSchema, corridorUpdateSchema } from '@/lib/validation/schemas';
import type { Actor } from '@/server/auth/actor';
import { hasRole, mfaIsRecent } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { sha256Hex } from '@/server/security/crypto';
import { AUDIT_GENESIS_HASH, audit, notify, securitySettings, type Deps } from './context';
import type { LedgerService } from './ledger-service';
import type { PaymentService } from './payment-service';

async function requireMfa(deps: Deps, actor: Actor) {
    const settings = await deps.uow.run((db) => securitySettings(db));
    if (!mfaIsRecent(actor, settings.sensitiveActionMfaMaxAgeMinutes, deps.clock.now()))
        throw new AppError('MFA_REQUIRED', 'Recent MFA verification required');
}

/** Legal / regulatory holds — separate from commercial disputes and stronger than them. */
export class ComplianceService {
    constructor(
        private readonly deps: Deps,
        private readonly payments: PaymentService
    ) {}

    async placeHold(actor: Actor, transactionId: string, rawInput: unknown) {
        if (!hasRole(actor, 'compliance_analyst')) throw forbidden();
        await requireMfa(this.deps, actor);
        const parsed = complianceHoldSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid hold', { issues: parsed.error.issues });
        return this.deps.uow.run(async (db) => {
            const tx = await db.transactions.get(transactionId);
            if (!tx) throw notFound('Transaction');
            const hold = await db.complianceHolds.insert({
                id: this.deps.ids.id(),
                transactionId,
                ...parsed.data,
                status: 'ACTIVE',
                placedBy: actor.userId,
                placedAt: this.deps.clock.now().toISOString()
            });
            // Parties are told the file is "under review" without details (no tipping-off).
            await audit(
                this.deps,
                db,
                actor,
                'compliance.hold_placed',
                { type: 'compliance_hold', id: hold.id },
                { transactionId, metadata: { type: hold.type } }
            );
            return hold;
        });
    }

    async liftHold(actor: Actor, holdId: string, notes: string) {
        if (!hasRole(actor, 'compliance_analyst')) throw forbidden();
        await requireMfa(this.deps, actor);
        if (notes.trim().length < 5) throw new AppError('VALIDATION', 'A justification is required');
        const hold = await this.deps.uow.run(async (db) => {
            const h = await db.complianceHolds.get(holdId);
            if (!h || h.status !== 'ACTIVE') throw notFound('Active hold');
            if (h.placedBy === actor.userId) throw forbidden('Four-eyes principle: another analyst must lift this hold');
            const updated = await db.complianceHolds.update(holdId, {
                status: 'LIFTED',
                liftedBy: actor.userId,
                liftedAt: this.deps.clock.now().toISOString(),
                notes: `${h.notes}\n---\n${notes}`
            });
            await audit(
                this.deps,
                db,
                actor,
                'compliance.hold_lifted',
                { type: 'compliance_hold', id: holdId },
                { transactionId: h.transactionId }
            );
            return updated;
        });
        await this.payments.retryBlockedReleases({ kind: 'SYSTEM', id: 'system' }, hold.transactionId);
        return hold;
    }

    async list(actor: Actor) {
        if (!hasRole(actor, 'compliance_analyst', 'auditor')) throw forbidden();
        return this.deps.uow.run((db) => db.complianceHolds.list());
    }
}

export class ReconciliationService {
    constructor(
        private readonly deps: Deps,
        private readonly ledger: LedgerService
    ) {}

    /** Compares the partner statement with ledger settlement journals (by external reference). */
    async run(actor: Actor): Promise<Reconciliation> {
        if (!hasRole(actor, 'finance_operator')) throw forbidden();
        const statement = await this.deps.payments.reconcileTransactions({
            from: '1970-01-01T00:00:00Z',
            to: this.deps.clock.now().toISOString()
        });
        return this.deps.uow.run(async (db) => {
            const journals = (await db.ledgerJournals.list()).filter((j) =>
                ['FUNDS_REPORTED_RECEIVED', 'PAYOUT_SETTLED', 'REFUND_SETTLED'].includes(j.kind)
            );
            const reversed = new Set((await db.ledgerJournals.list()).filter((j) => j.reversesJournalId).map((j) => j.reversesJournalId));
            const ledgerByRef = new Map<string, { amount: bigint; currency: CurrencyCode; kind: string }>();
            for (const j of journals) {
                if (reversed.has(j.id) || !j.externalReference) continue;
                const entries = await db.ledgerEntries.findBy({ journalId: j.id });
                const debit = entries.filter((e) => e.direction === 'DEBIT').reduce((a, e) => a + e.amountMinor, 0n);
                ledgerByRef.set(j.externalReference, { amount: debit, currency: entries[0]!.currency, kind: j.kind });
            }
            const items: ReconciliationItem[] = [];
            const seen = new Set<string>();
            for (const line of statement) {
                seen.add(line.externalReference);
                const l = ledgerByRef.get(line.externalReference);
                items.push({
                    externalReference: line.externalReference,
                    kind: line.kind,
                    providerAmountMinor: line.amountMinor,
                    ledgerAmountMinor: l?.amount.toString(),
                    currency: line.currency as CurrencyCode,
                    result: !l
                        ? 'MISSING_IN_LEDGER'
                        : l.amount.toString() !== line.amountMinor || l.currency !== line.currency
                          ? 'AMOUNT_MISMATCH'
                          : 'MATCHED'
                });
            }
            for (const [ref, l] of ledgerByRef) {
                if (!seen.has(ref))
                    items.push({
                        externalReference: ref,
                        kind: l.kind,
                        ledgerAmountMinor: l.amount.toString(),
                        currency: l.currency,
                        result: 'MISSING_AT_PROVIDER'
                    });
            }
            const rec: Reconciliation = {
                id: this.deps.ids.id(),
                provider: this.deps.payments.name,
                runBy: actor.userId,
                runAt: this.deps.clock.now().toISOString(),
                status: items.every((i) => i.result === 'MATCHED') ? 'MATCHED' : 'DISCREPANCIES',
                items
            };
            await db.reconciliations.insert(rec);
            await audit(
                this.deps,
                db,
                actor,
                'reconciliation.run',
                { type: 'reconciliation', id: rec.id },
                { metadata: { status: rec.status, items: items.length } }
            );
            return rec;
        });
    }

    async list(actor: Actor) {
        if (!hasRole(actor, 'finance_operator', 'auditor')) throw forbidden();
        return this.deps.uow.run(async (db) => (await db.reconciliations.list()).sort((a, b) => b.runAt.localeCompare(a.runAt)));
    }
}

export class AdminService {
    constructor(
        private readonly deps: Deps,
        private readonly ledger: LedgerService
    ) {}

    async overview(actor: Actor) {
        if (!hasRole(actor, 'compliance_analyst', 'dispute_manager', 'finance_operator', 'auditor', 'document_reviewer', 'platform_admin'))
            throw forbidden();
        return this.deps.uow.run(async (db) => {
            const txs = await db.transactions.list();
            const byStatus: Record<string, number> = {};
            for (const t of txs) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
            return {
                transactions: txs.length,
                byStatus,
                openAlerts: (await db.riskAlerts.list()).filter((a) => a.status === 'OPEN' || a.status === 'IN_REVIEW').length,
                pendingKyc: (await db.identityVerifications.findBy({ status: 'PENDING' })).length,
                documentsToReview: (await db.documents.findBy({ status: 'PENDING_REVIEW' })).length,
                openDisputes: (await db.disputes.list()).filter((d) =>
                    ['AWAITING_RESPONSE', 'UNDER_REVIEW', 'DECIDED', 'EXECUTING'].includes(d.status)
                ).length,
                failedProviderEvents: (await db.providerEvents.findBy({ status: 'FAILED' })).length,
                activeHolds: (await db.complianceHolds.findBy({ status: 'ACTIVE' })).length,
                trialBalance: await this.ledger.trialBalance(db)
            };
        });
    }

    async listTransactions(actor: Actor) {
        if (!hasRole(actor, 'compliance_analyst', 'dispute_manager', 'finance_operator', 'auditor', 'document_reviewer')) throw forbidden();
        return this.deps.uow.run(async (db) => (await db.transactions.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }

    async listDocumentsToReview(actor: Actor) {
        if (!hasRole(actor, 'document_reviewer', 'compliance_analyst')) throw forbidden();
        return this.deps.uow.run(async (db) =>
            Promise.all(
                (await db.documents.list())
                    .filter((d) => d.status !== 'SUPERSEDED')
                    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
                    .map(async (d) => ({
                        document: d,
                        reference: d.transactionId ? (await db.transactions.get(d.transactionId))?.reference : undefined
                    }))
            )
        );
    }

    async listOrganizations(actor: Actor) {
        if (!hasRole(actor, 'compliance_analyst', 'auditor')) throw forbidden();
        return this.deps.uow.run(async (db) =>
            Promise.all(
                (await db.organizations.list()).map(async (o) => ({
                    organization: o,
                    owners: await db.beneficialOwners.findBy({ organizationId: o.id })
                }))
            )
        );
    }

    async listUsers(actor: Actor) {
        if (!hasRole(actor, 'compliance_analyst', 'auditor', 'platform_admin')) throw forbidden();
        return this.deps.uow.run(async (db) => (await db.users.list()).map(({ mfaTotpSecret: _secret, ...u }) => u));
    }

    async providerEvents(actor: Actor) {
        if (!hasRole(actor, 'finance_operator', 'auditor')) throw forbidden();
        return this.deps.uow.run(async (db) => (await db.providerEvents.list()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
    }

    async providerConnections(actor: Actor) {
        if (!hasRole(actor, 'finance_operator', 'platform_admin', 'auditor')) throw forbidden();
        return this.deps.uow.run((db) => db.providerConnections.list());
    }

    async ledgerView(actor: Actor) {
        if (!hasRole(actor, 'finance_operator', 'auditor')) throw forbidden();
        return this.deps.uow.run(async (db) => {
            const accounts = await db.ledgerAccounts.list();
            const balances = await Promise.all(
                accounts.map(async (a) => ({ account: a, balanceMinor: (await this.ledger.balance(db, a.code)).toString() }))
            );
            const journals = (await db.ledgerJournals.list()).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
            const entries = await db.ledgerEntries.list();
            return { balances, journals, entries, trialBalance: await this.ledger.trialBalance(db) };
        });
    }

    async auditLog(actor: Actor, filter: { transactionId?: string } = {}) {
        if (!hasRole(actor, 'auditor', 'compliance_analyst')) throw forbidden();
        return this.deps.uow.run(async (db) => {
            const events = (await db.auditEvents.findBy({ transactionId: filter.transactionId })).sort((a, b) => b.sequence - a.sequence);
            return { events, chain: await this.verifyChainInTx(await db.auditEvents.list()) };
        });
    }

    /** Recomputes the hash chain to detect tampering or deleted events. */
    async verifyChainInTx(all: AuditEvent[]) {
        const sorted = [...all].sort((a, b) => a.sequence - b.sequence);
        let previous = AUDIT_GENESIS_HASH;
        for (const [i, e] of sorted.entries()) {
            const { previousHash, hash, ...body } = e;
            if (e.sequence !== i + 1 || previousHash !== previous || sha256Hex(previous + canonicalJson(body)) !== hash)
                return { valid: false, brokenAt: e.sequence, length: sorted.length };
            previous = hash;
        }
        return { valid: true, length: sorted.length };
    }

    /** Any authenticated user may read corridor configuration. */
    async corridors(_actor: Actor) {
        return this.deps.uow.run((db) => db.corridors.list());
    }

    async updateCorridor(actor: Actor, corridorId: string, rawInput: unknown) {
        if (!hasRole(actor, 'platform_admin')) throw forbidden();
        await requireMfa(this.deps, actor);
        const parsed = corridorUpdateSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid corridor settings', { issues: parsed.error.issues });
        return this.deps.uow.run(async (db) => {
            const c = await db.corridors.get(corridorId);
            if (!c) throw notFound('Corridor');
            const threshold = parseMoney(parsed.data.reviewThreshold, parsed.data.reviewThresholdCurrency as CurrencyCode);
            const updated = await db.corridors.update(corridorId, {
                enabled: parsed.data.enabled,
                reviewThresholdMinor: { ...c.reviewThresholdMinor, [threshold.currency]: threshold.amountMinor.toString() },
                updatedAt: this.deps.clock.now().toISOString(),
                updatedBy: actor.userId
            });
            await audit(
                this.deps,
                db,
                actor,
                'config.corridor_updated',
                { type: 'corridor', id: corridorId },
                { metadata: { enabled: parsed.data.enabled, threshold: threshold.amountMinor.toString(), currency: threshold.currency } }
            );
            return updated;
        });
    }

    async securitySettings(actor: Actor) {
        if (!hasRole(actor, 'platform_admin', 'auditor')) throw forbidden();
        return this.deps.uow.run((db) => securitySettings(db));
    }

    async updateSecuritySettings(actor: Actor, patch: { payoutAccountCoolingOffHours?: number; sensitiveActionMfaMaxAgeMinutes?: number }) {
        if (!hasRole(actor, 'platform_admin')) throw forbidden();
        await requireMfa(this.deps, actor);
        const cooling = patch.payoutAccountCoolingOffHours;
        const mfa = patch.sensitiveActionMfaMaxAgeMinutes;
        if (cooling !== undefined && (!Number.isInteger(cooling) || cooling < 24 || cooling > 720))
            throw new AppError('VALIDATION', 'Cooling-off must be between 24 and 720 hours');
        if (mfa !== undefined && (!Number.isInteger(mfa) || mfa < 1 || mfa > 60))
            throw new AppError('VALIDATION', 'MFA window must be between 1 and 60 minutes');
        return this.deps.uow.run(async (db) => {
            const current = await securitySettings(db);
            const next = { ...current, ...patch, updatedAt: this.deps.clock.now().toISOString(), updatedBy: actor.userId };
            if (await db.securitySettings.get('default')) await db.securitySettings.update('default', next);
            else await db.securitySettings.insert({ id: 'default', ...next });
            await audit(
                this.deps,
                db,
                actor,
                'config.security_settings_updated',
                { type: 'security_settings', id: 'default' },
                { metadata: patch }
            );
            return next;
        });
    }
}

export class NotificationService {
    constructor(private readonly deps: Deps) {}

    async list(actor: Actor) {
        return this.deps.uow.run(async (db) =>
            (await db.notifications.findBy({ userId: actor.userId })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        );
    }

    async markAllRead(actor: Actor) {
        return this.deps.uow.run(async (db) => {
            for (const n of await db.notifications.findBy({ userId: actor.userId })) {
                if (!n.readAt) await db.notifications.update(n.id, { readAt: this.deps.clock.now().toISOString() });
            }
        });
    }

    async push(userId: string, type: string, params: Record<string, string>) {
        return this.deps.uow.run((db) => notify(this.deps, db, userId, type, params));
    }
}
