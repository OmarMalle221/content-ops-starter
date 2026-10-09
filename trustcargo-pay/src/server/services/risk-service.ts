import { evaluateRisk, RULES, type PartyFacts, type RiskContext } from '@/domain/risk/engine';
import type { RiskAlert } from '@/domain/model';
import { riskReviewSchema } from '@/lib/validation/schemas';
import type { Db } from '@/server/ports/db';
import type { Actor } from '@/server/auth/actor';
import { SYSTEM, hasRole } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { audit, notifyRole, securitySettings, type Deps } from './context';

const OPEN_STATUSES: RiskAlert['status'][] = ['OPEN', 'IN_REVIEW'];

export class RiskService {
    /** Called after a review unblocks funds movement. */
    onAlertsCleared?: (transactionId: string) => Promise<void>;

    constructor(private readonly deps: Deps) {}

    async buildContext(db: Db, transactionId: string): Promise<RiskContext> {
        const transaction = (await db.transactions.get(transactionId))!;
        const now = this.deps.clock.now();
        const parties: PartyFacts[] = [];
        for (const party of await db.transactionParties.findBy({ transactionId })) {
            if (party.status === 'DECLINED' || party.status === 'REMOVED') continue;
            const user = party.userId ? await db.users.get(party.userId) : undefined;
            const organization = party.organizationId ? await db.organizations.get(party.organizationId) : undefined;
            const kycs = user ? await db.identityVerifications.findBy({ subjectType: 'USER', subjectId: user.id }) : [];
            const kyc = kycs.filter((k) => k.status === 'VERIFIED').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const screenings = user ? await db.screeningResults.findBy({ subjectId: user.id }) : [];
            const screening = screenings.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
            const payoutAccounts = [
                ...(user ? await db.paymentAccounts.findBy({ ownerType: 'USER', ownerId: user.id }) : []),
                ...(organization ? await db.paymentAccounts.findBy({ ownerType: 'ORGANIZATION', ownerId: organization.id }) : [])
            ];
            const sessions = user ? await db.sessionEvents.findBy({ userId: user.id }) : [];
            parties.push({ party, user, organization, kyc, screening, payoutAccounts, sessions });
        }
        const sellerTxs = await db.transactions.findBy({ createdBy: transaction.createdBy });
        const dayAgo = now.getTime() - 86_400_000;
        return {
            now,
            transaction,
            corridor: await db.corridors.get(transaction.corridorId),
            parties,
            vehicle: await db.vehicles.findOne({ transactionId }),
            documents: await db.documents.findBy({ transactionId }),
            contractVersions: await db.contractVersions.findBy({ transactionId }),
            sellerTransactionsLast24h: sellerTxs.filter((t) => new Date(t.createdAt).getTime() >= dayAgo).length,
            sellerPastAmountsMinor: sellerTxs
                .filter((t) => t.id !== transactionId && t.amount.currency === transaction.amount.currency)
                .map((t) => t.amount.amountMinor),
            coolingOffHours: (await securitySettings(db)).payoutAccountCoolingOffHours
        };
    }

    /** Re-evaluates all rules for a transaction, de-duplicating by fingerprint. */
    async evaluateInTx(db: Db, transactionId: string): Promise<void> {
        const drafts = evaluateRisk(await this.buildContext(db, transactionId));
        const now = this.deps.clock.now().toISOString();
        const seen = new Set<string>();
        for (const d of drafts) {
            seen.add(d.fingerprint);
            const existing = await db.riskAlerts.findOne({ fingerprint: d.fingerprint });
            if (existing) continue;
            const alert: RiskAlert = {
                id: this.deps.ids.id(),
                ruleId: d.ruleId,
                category: d.category,
                severity: d.severity,
                transactionId,
                subjectUserId: d.subjectUserId,
                fingerprint: d.fingerprint,
                reasons: d.reasons,
                recommendedAction: d.recommendedAction,
                blocksFundsMovement: d.blocksFundsMovement,
                status: 'OPEN',
                createdAt: now,
                updatedAt: now
            };
            await db.riskAlerts.insert(alert);
            await audit(
                this.deps,
                db,
                SYSTEM,
                'risk.alert_raised',
                { type: 'risk_alert', id: alert.id },
                { transactionId, metadata: { ruleId: d.ruleId, severity: d.severity } }
            );
            if (d.severity === 'HIGH' || d.severity === 'CRITICAL') {
                const tx = (await db.transactions.get(transactionId))!;
                await notifyRole(
                    this.deps,
                    db,
                    'compliance_analyst',
                    'risk.alert_raised',
                    { reference: tx.reference, ruleId: d.ruleId },
                    transactionId
                );
            }
        }
        // Auto-clear alerts whose condition disappeared, only for rules that allow it (e.g. missing documents now provided).
        const autoRules = new Set(RULES.filter((r) => r.autoResolvable).map((r) => r.id));
        for (const alert of await db.riskAlerts.findBy({ transactionId })) {
            if (
                OPEN_STATUSES.includes(alert.status) &&
                alert.status === 'OPEN' &&
                autoRules.has(alert.ruleId) &&
                !seen.has(alert.fingerprint)
            ) {
                await db.riskAlerts.update(alert.id, { status: 'RESOLVED', updatedAt: now });
                await audit(
                    this.deps,
                    db,
                    SYSTEM,
                    'risk.alert_auto_cleared',
                    { type: 'risk_alert', id: alert.id },
                    { transactionId, metadata: { ruleId: alert.ruleId } }
                );
            }
        }
    }

    async blockingAlerts(db: Db, transactionId: string): Promise<RiskAlert[]> {
        return (await db.riskAlerts.findBy({ transactionId })).filter((a) => a.blocksFundsMovement && OPEN_STATUSES.includes(a.status));
    }

    async review(actor: Actor, alertId: string, rawInput: unknown) {
        if (!hasRole(actor, 'compliance_analyst')) throw forbidden();
        const parsed = riskReviewSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid review', { issues: parsed.error.issues });
        const input = parsed.data;
        const result = await this.deps.uow.run(async (db) => {
            const alert = await db.riskAlerts.get(alertId);
            if (!alert) throw notFound('Alert');
            if (!OPEN_STATUSES.includes(alert.status)) throw new AppError('CONFLICT', 'Alert already closed');
            const status: RiskAlert['status'] =
                input.decision === 'FALSE_POSITIVE' ? 'DISMISSED' : input.decision === 'RISK_MITIGATED' ? 'RESOLVED' : 'IN_REVIEW';
            const now = this.deps.clock.now().toISOString();
            await db.riskReviews.insert({
                id: this.deps.ids.id(),
                alertId,
                reviewerId: actor.userId,
                decision: input.decision,
                notes: input.notes,
                createdAt: now
            });
            const updated = await db.riskAlerts.update(alertId, { status, updatedAt: now });
            await audit(
                this.deps,
                db,
                actor,
                'risk.alert_reviewed',
                { type: 'risk_alert', id: alertId },
                { transactionId: alert.transactionId, metadata: { decision: input.decision, status } }
            );
            return updated;
        });
        if (result.transactionId && (result.status === 'DISMISSED' || result.status === 'RESOLVED'))
            await this.onAlertsCleared?.(result.transactionId);
        return result;
    }

    async listAlerts(actor: Actor, filter: { status?: RiskAlert['status']; transactionId?: string } = {}) {
        if (!hasRole(actor, 'compliance_analyst', 'auditor')) throw forbidden();
        return this.deps.uow.run(async (db) => {
            const alerts = await db.riskAlerts.findBy({ status: filter.status, transactionId: filter.transactionId });
            return Promise.all(
                alerts.map(async (a) => ({
                    alert: a,
                    reviews: await db.riskReviews.findBy({ alertId: a.id }),
                    reference: a.transactionId ? (await db.transactions.get(a.transactionId))?.reference : undefined
                }))
            );
        });
    }

    async recordSession(userId: string, session: { country: string; deviceFingerprintHash: string; ipHash: string }) {
        return this.deps.uow.run(async (db) => {
            await db.sessionEvents.insert({ id: this.deps.ids.id(), userId, at: this.deps.clock.now().toISOString(), ...session });
        });
    }
}
