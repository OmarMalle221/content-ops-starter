import { money, parseMoney, subtract, type CurrencyCode } from '@/domain/money';
import type { Dispute, DisputeDecision } from '@/domain/model';
import { disputeDecisionSchema, disputeMessageSchema, openDisputeSchema } from '@/lib/validation/schemas';
import type { Db } from '@/server/ports/db';
import type { Actor } from '@/server/auth/actor';
import { hasRole, mfaIsRecent } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { accessTransaction, audit, notify, notifyRole, requireStaffRole, securitySettings, type Deps } from './context';
import type { PaymentService } from './payment-service';
import type { Workflow } from './workflow';

const OPEN: Dispute['status'][] = ['AWAITING_RESPONSE', 'UNDER_REVIEW', 'DECIDED', 'EXECUTING'];

/**
 * Commercial dispute workflow. Regulatory freezes / court orders are NOT disputes: they are
 * compliance holds (ComplianceService) and apply regardless of any dispute outcome.
 */
export class DisputeService {
    constructor(
        private readonly deps: Deps,
        private readonly workflow: Workflow,
        private readonly payments: PaymentService
    ) {}

    private now() {
        return this.deps.clock.now().toISOString();
    }

    async open(actor: Actor, transactionId: string, rawInput: unknown) {
        const parsed = openDisputeSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid dispute', { issues: parsed.error.issues });
        const input = parsed.data;
        return this.deps.uow.run(async (db) => {
            const { tx, party } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER', 'BUYER'], write: true });
            const role = party!.role as 'SELLER' | 'BUYER';
            if (input.milestoneId) {
                const m = await db.milestones.get(input.milestoneId);
                if (!m || m.transactionId !== tx.id) throw notFound('Milestone');
            }
            const version = (await db.contractVersions.get(tx.currentContractVersionId!))!;
            const updated = await this.workflow.transition(db, tx, 'DISPUTE_OPENED', role, actor, {
                patch: { statusBeforeDispute: tx.status },
                metadata: { reason: input.reason }
            });
            const dispute: Dispute = {
                id: this.deps.ids.id(),
                transactionId,
                milestoneId: input.milestoneId,
                openedBy: actor.userId,
                openedByRole: role,
                reason: input.reason,
                description: input.description,
                requestedOutcome: input.requestedOutcome,
                status: 'AWAITING_RESPONSE',
                responseDueAt: new Date(this.deps.clock.now().getTime() + version.terms.deadlines.reviewDays * 86_400_000).toISOString(),
                createdAt: this.now(),
                updatedAt: this.now()
            };
            await db.disputes.insert(dispute);
            await db.disputeMessages.insert({
                id: this.deps.ids.id(),
                disputeId: dispute.id,
                authorId: actor.userId,
                authorRole: role,
                body: input.description,
                documentIds: [],
                createdAt: this.now()
            });
            await audit(
                this.deps,
                db,
                actor,
                'dispute.opened',
                { type: 'dispute', id: dispute.id },
                { transactionId, metadata: { reason: input.reason, role } }
            );
            const other = (await db.transactionParties.findBy({ transactionId })).find(
                (p) => p.role === (role === 'BUYER' ? 'SELLER' : 'BUYER')
            );
            await notify(this.deps, db, other?.userId, 'dispute.opened', { reference: tx.reference }, transactionId);
            await notifyRole(this.deps, db, 'dispute_manager', 'dispute.opened', { reference: tx.reference }, transactionId);
            return { dispute, transaction: updated };
        });
    }

    private async loadForParticipant(db: Db, actor: Actor, disputeId: string) {
        const dispute = await db.disputes.get(disputeId);
        if (!dispute) throw notFound('Dispute');
        if (hasRole(actor, 'dispute_manager') || actor.pendingPlatformRoles?.includes('dispute_manager')) {
            await requireStaffRole(this.deps, actor, ['dispute_manager'], db);
            return { dispute, authorRole: 'PLATFORM' as const };
        }
        const { party } = await accessTransaction(db, actor, dispute.transactionId, { roles: ['SELLER', 'BUYER'], write: true });
        return { dispute, authorRole: party!.role as 'SELLER' | 'BUYER' };
    }

    /** Adversarial exchange. The first response from the other party moves the case to review. */
    async addMessage(actor: Actor, disputeId: string, rawInput: unknown) {
        const parsed = disputeMessageSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid message', { issues: parsed.error.issues });
        return this.deps.uow.run(async (db) => {
            const { dispute, authorRole } = await this.loadForParticipant(db, actor, disputeId);
            if (!OPEN.includes(dispute.status) || dispute.status === 'EXECUTING')
                throw new AppError('PRECONDITION_FAILED', 'This dispute no longer accepts messages');
            for (const docId of parsed.data.documentIds) {
                const d = await db.documents.get(docId);
                if (!d || d.transactionId !== dispute.transactionId) throw notFound('Document');
            }
            const message = await db.disputeMessages.insert({
                id: this.deps.ids.id(),
                disputeId,
                authorId: actor.userId,
                authorRole,
                body: parsed.data.body,
                documentIds: parsed.data.documentIds,
                createdAt: this.now()
            });
            if (dispute.status === 'AWAITING_RESPONSE' && authorRole !== 'PLATFORM' && authorRole !== dispute.openedByRole) {
                await db.disputes.update(disputeId, { status: 'UNDER_REVIEW', updatedAt: this.now() });
            }
            await audit(
                this.deps,
                db,
                actor,
                'dispute.message_added',
                { type: 'dispute', id: disputeId },
                { transactionId: dispute.transactionId, metadata: { authorRole } }
            );
            for (const p of await db.transactionParties.findBy({ transactionId: dispute.transactionId })) {
                if (p.userId && p.userId !== actor.userId && (p.role === 'SELLER' || p.role === 'BUYER'))
                    await notify(this.deps, db, p.userId, 'dispute.message', {}, dispute.transactionId);
            }
            return message;
        });
    }

    async assign(actor: Actor, disputeId: string) {
        await requireStaffRole(this.deps, actor, ['dispute_manager']);
        return this.deps.uow.run(async (db) => {
            const dispute = await db.disputes.get(disputeId);
            if (!dispute) throw notFound('Dispute');
            const updated = await db.disputes.update(disputeId, {
                assignedTo: actor.userId,
                status: dispute.status === 'AWAITING_RESPONSE' ? 'UNDER_REVIEW' : dispute.status,
                updatedAt: this.now()
            });
            await audit(
                this.deps,
                db,
                actor,
                'dispute.assigned',
                { type: 'dispute', id: disputeId },
                { transactionId: dispute.transactionId }
            );
            return updated;
        });
    }

    async withdraw(actor: Actor, disputeId: string) {
        return this.deps.uow
            .run(async (db) => {
                const dispute = await db.disputes.get(disputeId);
                if (!dispute) throw notFound('Dispute');
                const { tx } = await accessTransaction(db, actor, dispute.transactionId, { roles: ['SELLER', 'BUYER'], write: true });
                if (dispute.openedBy !== actor.userId) throw forbidden('Only the party who opened the dispute can withdraw it');
                if (!['AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(dispute.status))
                    throw new AppError('PRECONDITION_FAILED', 'The dispute can no longer be withdrawn');
                await db.disputes.update(disputeId, { status: 'WITHDRAWN', resolvedAt: this.now(), updatedAt: this.now() });
                const updated = await this.workflow.transition(db, tx, 'DISPUTE_WITHDRAWN', dispute.openedByRole, actor, {
                    patch: { statusBeforeDispute: undefined }
                });
                await audit(this.deps, db, actor, 'dispute.withdrawn', { type: 'dispute', id: disputeId }, { transactionId: tx.id });
                return updated;
            })
            .then(async (tx) => {
                await this.payments.retryBlockedReleases({ kind: 'SYSTEM', id: 'system' }, tx.id);
                return tx;
            });
    }

    /**
     * Decision by an authorised dispute manager (recent MFA). Produces instructions to the partner;
     * nothing is paid or refunded until the partner confirms through a signed event.
     */
    async decide(actor: Actor, disputeId: string, rawInput: unknown) {
        await requireStaffRole(this.deps, actor, ['dispute_manager']);
        const parsed = disputeDecisionSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid decision', { issues: parsed.error.issues });
        const input = parsed.data;
        const result = await this.deps.uow.run(async (db) => {
            const settings = await securitySettings(db);
            const recentMfa = mfaIsRecent(actor, settings.sensitiveActionMfaMaxAgeMinutes, this.deps.clock.now());
            if (!recentMfa) throw new AppError('MFA_REQUIRED', 'A recent MFA verification is required to decide a dispute');
            const dispute = await db.disputes.get(disputeId);
            if (!dispute) throw notFound('Dispute');
            if (!['AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(dispute.status)) throw new AppError('CONFLICT', 'Dispute already decided');
            const parties = await db.transactionParties.findBy({ transactionId: dispute.transactionId });
            if (parties.some((p) => p.userId === actor.userId))
                throw forbidden('Conflict of interest: you are a party to this transaction');
            const tx = (await db.transactions.get(dispute.transactionId))!;
            const currency = tx.amount.currency as CurrencyCode;
            const held = await this.payments.heldAmount(db, tx);
            let sellerAmount = money(0n, currency);
            if (input.outcome === 'RELEASE_TO_SELLER') sellerAmount = held;
            if (input.outcome === 'SPLIT') {
                if (!input.sellerAmount) throw new AppError('VALIDATION', 'Seller amount required for a split');
                sellerAmount = parseMoney(input.sellerAmount, currency);
                if (sellerAmount.amountMinor <= 0n || sellerAmount.amountMinor >= held.amountMinor)
                    throw new AppError('VALIDATION', 'Split amount must be strictly between 0 and the held amount');
            }
            const buyerRefundAmount = input.outcome === 'RESUME' ? money(0n, currency) : subtract(held, sellerAmount);
            const decision: DisputeDecision = {
                id: this.deps.ids.id(),
                disputeId,
                transactionId: tx.id,
                decidedBy: actor.userId,
                outcome: input.outcome,
                sellerAmount,
                buyerRefundAmount,
                rationale: input.rationale,
                contractClause: input.contractClause,
                mfaVerifiedAt: actor.mfaVerifiedAt!,
                createdAt: this.now()
            };
            await db.disputeDecisions.insert(decision);
            const extra = { recentMfa };
            if (input.outcome === 'RESUME') {
                await this.workflow.transition(db, tx, 'DISPUTE_RESUMED', 'DISPUTE_MANAGER', actor, {
                    extra,
                    patch: { statusBeforeDispute: undefined },
                    metadata: { decisionId: decision.id }
                });
                await db.disputes.update(disputeId, { status: 'RESOLVED', resolvedAt: this.now(), updatedAt: this.now() });
            } else if (input.outcome === 'RELEASE_TO_SELLER') {
                const updated = await this.workflow.transition(db, tx, 'DISPUTE_RELEASE_ORDERED', 'DISPUTE_MANAGER', actor, {
                    extra,
                    metadata: { decisionId: decision.id }
                });
                const r = await this.payments.authorizeReleaseInTx(
                    db,
                    actor,
                    updated,
                    sellerAmount,
                    { disputeDecisionId: decision.id },
                    { ignoreDispute: true }
                );
                if (r.blockers.length)
                    throw new AppError('PRECONDITION_FAILED', 'Release controls prevent executing this decision', { blockers: r.blockers });
                await db.disputes.update(disputeId, { status: 'EXECUTING', updatedAt: this.now() });
            } else {
                const updated = await this.workflow.transition(db, tx, 'DISPUTE_REFUND_ORDERED', 'DISPUTE_MANAGER', actor, {
                    extra,
                    metadata: { decisionId: decision.id }
                });
                await this.payments.authorizeRefundInTx(db, actor, updated, buyerRefundAmount, decision.id);
                if (sellerAmount.amountMinor > 0n) {
                    const r = await this.payments.authorizeReleaseInTx(
                        db,
                        actor,
                        updated,
                        sellerAmount,
                        { disputeDecisionId: decision.id },
                        { ignoreDispute: true }
                    );
                    if (r.blockers.length)
                        throw new AppError('PRECONDITION_FAILED', 'Release controls prevent executing this decision', {
                            blockers: r.blockers
                        });
                }
                await db.disputes.update(disputeId, { status: 'EXECUTING', updatedAt: this.now() });
            }
            await audit(
                this.deps,
                db,
                actor,
                'dispute.decided',
                { type: 'dispute', id: disputeId },
                {
                    transactionId: tx.id,
                    metadata: {
                        outcome: input.outcome,
                        sellerAmountMinor: sellerAmount.amountMinor.toString(),
                        buyerRefundMinor: buyerRefundAmount.amountMinor.toString(),
                        clause: input.contractClause
                    }
                }
            );
            for (const p of parties)
                if (p.userId)
                    await notify(this.deps, db, p.userId, 'dispute.decided', { reference: tx.reference, outcome: input.outcome }, tx.id);
            return decision;
        });
        await this.payments.dispatchPending(result.transactionId);
        return result;
    }

    /** Called after each settlement event: closes the dispute once nothing remains in flight. */
    async onSettlementProgress(db: Db, transactionId: string) {
        for (const d of await db.disputes.findBy({ transactionId, status: 'EXECUTING' })) {
            const decisions = await db.disputeDecisions.findBy({ disputeId: d.id });
            const ids = new Set(decisions.map((x) => x.id));
            const payouts = (await db.payouts.findBy({ transactionId })).filter((p) => p.disputeDecisionId && ids.has(p.disputeDecisionId));
            const refunds = (await db.refunds.findBy({ transactionId })).filter((r) => r.disputeDecisionId && ids.has(r.disputeDecisionId));
            const done = [
                ...payouts.map((p) => p.status === 'PAID' || p.status === 'CANCELLED'),
                ...refunds.map((r) => r.status === 'REFUNDED' || r.status === 'CANCELLED')
            ];
            if (done.length && done.every(Boolean)) {
                await db.disputes.update(d.id, { status: 'RESOLVED', resolvedAt: this.now(), updatedAt: this.now() });
                await audit(
                    this.deps,
                    db,
                    { kind: 'SYSTEM', id: 'system' },
                    'dispute.resolved',
                    { type: 'dispute', id: d.id },
                    { transactionId }
                );
            }
        }
    }

    async archive(actor: Actor, disputeId: string) {
        await requireStaffRole(this.deps, actor, ['dispute_manager']);
        return this.deps.uow.run(async (db) => {
            const d = await db.disputes.get(disputeId);
            if (!d) throw notFound('Dispute');
            if (d.status !== 'RESOLVED' && d.status !== 'WITHDRAWN')
                throw new AppError('PRECONDITION_FAILED', 'Only closed disputes can be archived');
            await audit(this.deps, db, actor, 'dispute.archived', { type: 'dispute', id: disputeId }, { transactionId: d.transactionId });
            return db.disputes.update(disputeId, { status: 'ARCHIVED', updatedAt: this.now() });
        });
    }

    async listAll(actor: Actor) {
        await requireStaffRole(this.deps, actor, ['dispute_manager', 'auditor', 'compliance_analyst']);
        return this.deps.uow.run(async (db) =>
            Promise.all(
                (await db.disputes.list())
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map(async (d) => ({ dispute: d, reference: (await db.transactions.get(d.transactionId))?.reference ?? '' }))
            )
        );
    }
}
