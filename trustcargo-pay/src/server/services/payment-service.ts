/**
 * Payment orchestration. Rules:
 *  - Money state only changes on AUTHENTICATED partner events (see ProviderEventService).
 *  - Outbound instructions (release / refund) are first persisted as REQUESTED together with the
 *    ledger authorisation journal, then submitted to the partner OUTSIDE the database transaction.
 *    Submission failures leave the record REQUESTED with the error, ready for an idempotent retry.
 */
import { journalTemplates } from '@/domain/ledger/ledger';
import { money, type CurrencyCode, type Money } from '@/domain/money';
import type { Milestone, Payout, Refund, Transaction } from '@/domain/model';
import type { Db } from '@/server/ports/db';
import { isProviderError } from '@/server/ports/payment-provider';
import type { Actor, AnyActor } from '@/server/auth/actor';
import { SYSTEM, hasRole } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { accessTransaction, audit, notify, notifyRole, securitySettings, type Deps } from './context';
import type { LedgerService } from './ledger-service';
import type { RiskService } from './risk-service';

export type ReleaseBlocker =
    | 'COMPLIANCE_HOLD_ACTIVE'
    | 'DISPUTE_OPEN'
    | 'BLOCKING_RISK_ALERTS'
    | 'PAYOUT_ACCOUNT_MISSING'
    | 'PAYOUT_ACCOUNT_UNVERIFIED'
    | 'PAYOUT_ACCOUNT_CURRENCY_MISMATCH'
    | 'PAYOUT_ACCOUNT_COOLING_OFF'
    | 'INSUFFICIENT_HELD_FUNDS';

export class PaymentService {
    constructor(
        private readonly deps: Deps,
        private readonly ledger: LedgerService,
        private readonly risk: RiskService
    ) {}

    private now() {
        return this.deps.clock.now().toISOString();
    }

    /* ------------------------------------------------------------------ funding */

    async requestFundingInstructions(actor: Actor, transactionId: string) {
        const prepared = await this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId, { roles: ['BUYER'], write: true });
            if (tx.status !== 'AWAITING_FUNDING')
                throw new AppError('PRECONDITION_FAILED', 'Funding is not open for this transaction', { status: tx.status });
            if ((await db.complianceHolds.findBy({ transactionId, status: 'ACTIVE' })).length) {
                throw new AppError('PRECONDITION_FAILED', 'Transaction under compliance review', {
                    failedGuards: ['COMPLIANCE_HOLD_ACTIVE']
                });
            }
            // The buyer must not be asked to pay before the seller has provided the corridor's pre-funding documents.
            const corridor = await db.corridors.get(tx.corridorId);
            const liveDocs = (await db.documents.findBy({ transactionId })).filter(
                (d) => !['SUPERSEDED', 'REJECTED', 'QUARANTINED'].includes(d.status)
            );
            const missingDocs = (corridor?.requiredDocumentsBeforeFunding ?? []).filter((type) => !liveDocs.some((d) => d.type === type));
            if (missingDocs.length) {
                throw new AppError('PRECONDITION_FAILED', 'Required documents missing', {
                    failedGuards: ['REQUIRED_DOCUMENTS_MISSING'],
                    missing: missingDocs
                });
            }
            const critical = (await this.risk.blockingAlerts(db, transactionId)).filter((a) => a.severity === 'CRITICAL');
            if (critical.length)
                throw new AppError('PRECONDITION_FAILED', 'Transaction under compliance review', {
                    failedGuards: ['BLOCKING_RISK_ALERTS']
                });
            const idempotencyKey = `fund:${tx.id}:${tx.currentContractVersionId}`;
            const existing = await db.paymentInstructions.findOne({ idempotencyKey });
            const buyer = (await db.users.get(actor.userId))!;
            return { tx, idempotencyKey, existing, payerName: buyer.fullName };
        });
        if (prepared.existing && prepared.existing.status !== 'CANCELLED' && prepared.existing.status !== 'FAILED')
            return prepared.existing;

        let result;
        try {
            result = await this.deps.payments.createPaymentInstruction({
                transactionId: prepared.tx.id,
                transactionReference: prepared.tx.reference,
                amount: prepared.tx.amount,
                payerName: prepared.payerName,
                idempotencyKey: prepared.existing ? `${prepared.idempotencyKey}:retry:${this.now()}` : prepared.idempotencyKey
            });
        } catch (e) {
            if (isProviderError(e))
                throw new AppError('PROVIDER_ERROR', 'The payment partner is temporarily unavailable. Please retry.', {
                    retryable: e.retryable
                });
            throw e;
        }
        return this.deps.uow.run(async (db) => {
            const now = this.now();
            const key = prepared.existing ? `${prepared.idempotencyKey}:${result.providerReference}` : prepared.idempotencyKey;
            const instruction = await db.paymentInstructions.insert({
                id: this.deps.ids.id(),
                transactionId: prepared.tx.id,
                provider: this.deps.payments.name,
                providerReference: result.providerReference,
                amount: prepared.tx.amount,
                payerUserId: actor.userId,
                status: 'CREATED',
                details: result.details,
                idempotencyKey: key,
                expiresAt: result.expiresAt,
                createdAt: now,
                updatedAt: now
            });
            await audit(
                this.deps,
                db,
                actor,
                'payment.instruction_created',
                { type: 'payment_instruction', id: instruction.id },
                {
                    transactionId: prepared.tx.id,
                    metadata: { provider: instruction.provider, providerReference: instruction.providerReference }
                }
            );
            return instruction;
        });
    }

    /* ------------------------------------------------------------------ releases */

    private async payeeAccount(db: Db, tx: Transaction) {
        const seller = (await db.transactionParties.findOne({ transactionId: tx.id, role: 'SELLER' }))!;
        const owner = seller.organizationId
            ? { ownerType: 'ORGANIZATION' as const, ownerId: seller.organizationId }
            : { ownerType: 'USER' as const, ownerId: seller.userId! };
        const account = (await db.paymentAccounts.findBy(owner)).find((a) => a.status !== 'DISABLED');
        return { seller, account };
    }

    /** Explains why funds cannot move right now (empty = allowed). */
    async releaseBlockers(db: Db, tx: Transaction, amount: Money, options: { ignoreDispute?: boolean } = {}): Promise<ReleaseBlocker[]> {
        const blockers: ReleaseBlocker[] = [];
        if ((await db.complianceHolds.findBy({ transactionId: tx.id, status: 'ACTIVE' })).length) blockers.push('COMPLIANCE_HOLD_ACTIVE');
        if (
            !options.ignoreDispute &&
            (await db.disputes.findBy({ transactionId: tx.id })).some((d) => !['RESOLVED', 'WITHDRAWN', 'ARCHIVED'].includes(d.status))
        ) {
            blockers.push('DISPUTE_OPEN');
        }
        if ((await this.risk.blockingAlerts(db, tx.id)).length) blockers.push('BLOCKING_RISK_ALERTS');
        const { account } = await this.payeeAccount(db, tx);
        const settings = await securitySettings(db);
        if (!account) blockers.push('PAYOUT_ACCOUNT_MISSING');
        else {
            if (account.status !== 'VERIFIED') blockers.push('PAYOUT_ACCOUNT_UNVERIFIED');
            if (account.currency !== tx.amount.currency) blockers.push('PAYOUT_ACCOUNT_CURRENCY_MISMATCH');
            if (
                account.replacesAccountId &&
                this.deps.clock.now().getTime() - new Date(account.createdAt).getTime() < settings.payoutAccountCoolingOffHours * 3_600_000
            ) {
                blockers.push('PAYOUT_ACCOUNT_COOLING_OFF');
            }
        }
        const held = await this.ledger.balance(db, `TX_HELD:${tx.id}:${tx.amount.currency}`);
        if (held < amount.amountMinor) blockers.push('INSUFFICIENT_HELD_FUNDS');
        return blockers;
    }

    /**
     * Records an authorised release (in the caller's unit of work). If blocked, nothing is created
     * and the blockers are returned; `retryBlockedReleases` re-attempts once the cause is cleared.
     */
    async authorizeReleaseInTx(
        db: Db,
        actor: AnyActor,
        tx: Transaction,
        amount: Money,
        source: { milestoneId?: string; disputeDecisionId?: string },
        options: { ignoreDispute?: boolean } = {}
    ): Promise<{ payout?: Payout; blockers: ReleaseBlocker[] }> {
        const blockers = await this.releaseBlockers(db, tx, amount, options);
        if (blockers.length) {
            await audit(
                this.deps,
                db,
                actor,
                'payout.blocked',
                { type: 'transaction', id: tx.id },
                { transactionId: tx.id, metadata: { blockers, ...source } }
            );
            await notifyRole(
                this.deps,
                db,
                'compliance_analyst',
                'payout.blocked',
                { reference: tx.reference, blockers: blockers.join(',') },
                tx.id
            );
            return { blockers };
        }
        const { seller, account } = await this.payeeAccount(db, tx);
        const now = this.now();
        const payout: Payout = {
            id: this.deps.ids.id(),
            transactionId: tx.id,
            milestoneId: source.milestoneId,
            disputeDecisionId: source.disputeDecisionId,
            payeePartyId: seller.id,
            paymentAccountId: account!.id,
            amount,
            status: 'REQUESTED',
            provider: this.deps.payments.name,
            idempotencyKey: `payout:${source.milestoneId ?? source.disputeDecisionId}:${this.deps.ids.id()}`,
            requestedBy: actor.kind === 'USER' ? actor.userId : actor.id,
            requestedAt: now,
            updatedAt: now,
            attempts: 0
        };
        await db.payouts.insert(payout);
        await this.ledger.post(
            db,
            journalTemplates.releaseAuthorized({
                provider: payout.provider,
                transactionId: tx.id,
                currency: amount.currency,
                amountMinor: amount.amountMinor,
                externalReference: payout.id,
                payoutId: payout.id
            }),
            actor
        );
        await audit(
            this.deps,
            db,
            actor,
            'payout.requested',
            { type: 'payout', id: payout.id },
            { transactionId: tx.id, metadata: { amountMinor: amount.amountMinor.toString(), currency: amount.currency, ...source } }
        );
        return { payout, blockers: [] };
    }

    async authorizeRefundInTx(db: Db, actor: AnyActor, tx: Transaction, amount: Money, disputeDecisionId: string): Promise<Refund> {
        if ((await db.complianceHolds.findBy({ transactionId: tx.id, status: 'ACTIVE' })).length) {
            throw new AppError('PRECONDITION_FAILED', 'A compliance hold prevents any movement of funds', {
                failedGuards: ['COMPLIANCE_HOLD_ACTIVE']
            });
        }
        const held = await this.ledger.balance(db, `TX_HELD:${tx.id}:${tx.amount.currency}`);
        if (held < amount.amountMinor)
            throw new AppError('PRECONDITION_FAILED', 'Refund exceeds funds reported as held', {
                failedGuards: ['INSUFFICIENT_HELD_FUNDS']
            });
        const buyer = (await db.transactionParties.findOne({ transactionId: tx.id, role: 'BUYER' }))!;
        const now = this.now();
        const refund: Refund = {
            id: this.deps.ids.id(),
            transactionId: tx.id,
            disputeDecisionId,
            payerPartyId: buyer.id,
            amount,
            status: 'REQUESTED',
            provider: this.deps.payments.name,
            idempotencyKey: `refund:${disputeDecisionId}:${this.deps.ids.id()}`,
            requestedBy: actor.kind === 'USER' ? actor.userId : actor.id,
            requestedAt: now,
            updatedAt: now,
            attempts: 0
        };
        await db.refunds.insert(refund);
        await this.ledger.post(
            db,
            journalTemplates.refundAuthorized({
                provider: refund.provider,
                transactionId: tx.id,
                currency: amount.currency,
                amountMinor: amount.amountMinor,
                externalReference: refund.id,
                refundId: refund.id
            }),
            actor
        );
        await audit(
            this.deps,
            db,
            actor,
            'refund.requested',
            { type: 'refund', id: refund.id },
            { transactionId: tx.id, metadata: { amountMinor: amount.amountMinor.toString(), currency: amount.currency } }
        );
        return refund;
    }

    /** Submits REQUESTED payouts/refunds to the partner. Never runs inside a unit of work. */
    async dispatchPending(transactionId: string): Promise<void> {
        const { payouts, refunds, fundingRef } = await this.deps.uow.run(async (db) => ({
            payouts: await db.payouts.findBy({ transactionId, status: 'REQUESTED' }),
            refunds: await db.refunds.findBy({ transactionId, status: 'REQUESTED' }),
            fundingRef: (await db.paymentInstructions.findOne({ transactionId, status: 'FUNDED' }))?.providerReference ?? ''
        }));
        for (const payout of payouts) {
            const account = await this.deps.uow.run(async (db) => db.paymentAccounts.get(payout.paymentAccountId));
            try {
                const submission = await this.deps.payments.requestAuthorizedRelease({
                    payoutId: payout.id,
                    transactionId,
                    amount: payout.amount,
                    payeeAccountToken: account!.providerToken,
                    idempotencyKey: payout.idempotencyKey,
                    authorizationReference: payout.milestoneId ?? payout.disputeDecisionId ?? ''
                });
                await this.deps.uow.run(async (db) => {
                    await db.payouts.update(payout.id, {
                        status: 'SUBMITTED',
                        providerReference: submission.providerReference,
                        attempts: payout.attempts + 1,
                        updatedAt: this.now(),
                        failureReason: undefined
                    });
                    await audit(
                        this.deps,
                        db,
                        SYSTEM,
                        'payout.submitted',
                        { type: 'payout', id: payout.id },
                        { transactionId, metadata: { providerReference: submission.providerReference } }
                    );
                });
            } catch (e) {
                await this.recordSubmissionFailure('payout', payout.id, transactionId, payout.attempts, e);
            }
        }
        for (const refund of refunds) {
            try {
                const submission = await this.deps.payments.requestAuthorizedRefund({
                    refundId: refund.id,
                    transactionId,
                    fundingReference: fundingRef,
                    amount: refund.amount,
                    idempotencyKey: refund.idempotencyKey,
                    authorizationReference: refund.disputeDecisionId ?? ''
                });
                await this.deps.uow.run(async (db) => {
                    await db.refunds.update(refund.id, {
                        status: 'SUBMITTED',
                        providerReference: submission.providerReference,
                        attempts: refund.attempts + 1,
                        updatedAt: this.now(),
                        failureReason: undefined
                    });
                    await audit(
                        this.deps,
                        db,
                        SYSTEM,
                        'refund.submitted',
                        { type: 'refund', id: refund.id },
                        { transactionId, metadata: { providerReference: submission.providerReference } }
                    );
                });
            } catch (e) {
                await this.recordSubmissionFailure('refund', refund.id, transactionId, refund.attempts, e);
            }
        }
    }

    private async recordSubmissionFailure(kind: 'payout' | 'refund', id: string, transactionId: string, attempts: number, error: unknown) {
        if (!isProviderError(error)) throw error;
        await this.deps.uow.run(async (db) => {
            const patch = { attempts: attempts + 1, failureReason: error.message.slice(0, 300), updatedAt: this.now() };
            if (kind === 'payout') await db.payouts.update(id, patch);
            else await db.refunds.update(id, patch);
            await audit(
                this.deps,
                db,
                SYSTEM,
                `${kind}.submission_failed`,
                { type: kind, id },
                { transactionId, metadata: { retryable: error.retryable, attempts: attempts + 1 } }
            );
            await notifyRole(this.deps, db, 'finance_operator', `${kind}.submission_failed`, { id }, transactionId);
        });
    }

    /**
     * Recovery entry point (finance/compliance or system after an alert is cleared):
     * - re-attempts releases for approved milestones that were blocked,
     * - replaces partner-FAILED transfers with new attempts,
     * - re-submits REQUESTED transfers that failed to reach the partner.
     */
    async retryBlockedReleases(actor: AnyActor, transactionId: string) {
        if (actor.kind === 'USER' && !hasRole(actor, 'finance_operator', 'compliance_analyst')) throw forbidden();
        const result = await this.deps.uow.run(async (db) => {
            const tx = await db.transactions.get(transactionId);
            if (!tx) throw notFound('Transaction');
            const created: string[] = [];
            const blockersSeen: ReleaseBlocker[] = [];
            const payouts = await db.payouts.findBy({ transactionId });
            for (const failed of payouts.filter((p) => p.status === 'FAILED')) {
                await db.payouts.update(failed.id, { status: 'CANCELLED', updatedAt: this.now() });
                const r = await this.authorizeReleaseInTx(
                    db,
                    actor,
                    tx,
                    failed.amount,
                    { milestoneId: failed.milestoneId, disputeDecisionId: failed.disputeDecisionId },
                    { ignoreDispute: Boolean(failed.disputeDecisionId) }
                );
                if (r.payout) created.push(r.payout.id);
                blockersSeen.push(...r.blockers);
            }
            if (tx.status === 'IN_PROGRESS' || tx.status === 'MILESTONE_REVIEW') {
                const milestones = await db.milestones.findBy({ transactionId, contractVersionId: tx.currentContractVersionId! });
                for (const m of milestones.filter((x) => x.status === 'APPROVED')) {
                    const live = (await db.payouts.findBy({ milestoneId: m.id })).filter(
                        (p) => p.status !== 'CANCELLED' && p.status !== 'FAILED'
                    );
                    if (live.length) continue;
                    const r = await this.authorizeReleaseInTx(db, actor, tx, m.amount, { milestoneId: m.id });
                    if (r.payout) created.push(r.payout.id);
                    blockersSeen.push(...r.blockers);
                }
            }
            for (const refund of (await db.refunds.findBy({ transactionId })).filter((r) => r.status === 'FAILED')) {
                await db.refunds.update(refund.id, { status: 'CANCELLED', updatedAt: this.now() });
                const replacement = await this.authorizeRefundInTx(db, actor, tx, refund.amount, refund.disputeDecisionId!);
                created.push(replacement.id);
            }
            return { created, blockers: [...new Set(blockersSeen)] };
        });
        await this.dispatchPending(transactionId);
        return result;
    }

    async releaseForMilestoneInTx(db: Db, actor: AnyActor, tx: Transaction, milestone: Milestone) {
        return this.authorizeReleaseInTx(db, actor, tx, milestone.amount, { milestoneId: milestone.id });
    }

    async heldAmount(db: Db, tx: Transaction): Promise<Money> {
        return money(await this.ledger.balance(db, `TX_HELD:${tx.id}:${tx.amount.currency}`), tx.amount.currency as CurrencyCode);
    }

    /** Buyer-side notification helper reused by event processing. */
    async notifyParties(db: Db, tx: Transaction, type: string, params: Record<string, string> = {}) {
        for (const p of await db.transactionParties.findBy({ transactionId: tx.id })) {
            if (p.userId && (p.role === 'SELLER' || p.role === 'BUYER'))
                await notify(this.deps, db, p.userId, type, { reference: tx.reference, ...params }, tx.id);
        }
    }
}
