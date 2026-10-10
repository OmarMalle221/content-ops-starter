import { milestoneDecisionSchema } from '@/lib/validation/schemas';
import type { Db } from '@/server/ports/db';
import type { Actor } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { truncateText } from '@/server/text';
import { accessTransaction, audit, notify, type Deps } from './context';
import type { PaymentService, ReleaseBlocker } from './payment-service';
import type { Workflow } from './workflow';
import { activeMilestone, currentMilestones } from './workflow';

export class MilestoneService {
    constructor(
        private readonly deps: Deps,
        private readonly workflow: Workflow,
        private readonly payments: PaymentService
    ) {}

    /** Links an uploaded document to the active milestone as evidence. */
    async attachEvidenceInTx(db: Db, actor: Actor, transactionId: string, milestoneId: string, documentId: string) {
        const { tx, party } = await accessTransaction(db, actor, transactionId, {
            roles: ['SELLER', 'INSPECTOR', 'FREIGHT_FORWARDER'],
            write: true
        });
        const milestone = await db.milestones.get(milestoneId);
        if (!milestone || milestone.transactionId !== tx.id || milestone.contractVersionId !== tx.currentContractVersionId)
            throw notFound('Milestone');
        if (!['ACTIVE', 'CHANGES_REQUESTED', 'PENDING'].includes(milestone.status))
            throw new AppError('PRECONDITION_FAILED', 'Evidence can only be added to an open milestone');
        const doc = await db.documents.get(documentId);
        if (!doc || doc.transactionId !== tx.id) throw notFound('Document');
        if (await db.milestoneEvidence.findOne({ milestoneId, documentId })) return;
        await db.milestoneEvidence.insert({
            id: this.deps.ids.id(),
            milestoneId,
            transactionId: tx.id,
            documentId,
            addedBy: actor.userId,
            addedAt: this.deps.clock.now().toISOString()
        });
        await audit(
            this.deps,
            db,
            actor,
            'milestone.evidence_added',
            { type: 'milestone', id: milestoneId },
            { transactionId: tx.id, metadata: { documentId, role: party?.role } }
        );
    }

    async attachEvidence(actor: Actor, transactionId: string, milestoneId: string, documentId: string) {
        return this.deps.uow.run((db) => this.attachEvidenceInTx(db, actor, transactionId, milestoneId, documentId));
    }

    /** Seller requests approval of the active milestone. Required evidence is enforced by the workflow guard. */
    async submit(actor: Actor, transactionId: string, milestoneId: string, note?: string) {
        return this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER'], write: true });
            const active = activeMilestone(await currentMilestones(db, tx));
            if (!active || active.id !== milestoneId)
                throw new AppError('PRECONDITION_FAILED', 'Only the current milestone can be submitted', {
                    failedGuards: ['NO_ACTIVE_MILESTONE']
                });
            const updated = await this.workflow.transition(db, tx, 'MILESTONE_SUBMITTED', 'SELLER', actor, {
                metadata: { milestoneId, sequence: active.sequence }
            });
            await db.milestones.update(milestoneId, {
                status: 'SUBMITTED',
                submittedAt: this.deps.clock.now().toISOString(),
                submissionNote: note === undefined ? undefined : truncateText(note, 2000),
                changeRequestReason: undefined
            });
            const buyer = await db.transactionParties.findOne({ transactionId, role: 'BUYER' });
            await notify(this.deps, db, buyer?.userId, 'milestone.submitted', { reference: tx.reference, title: active.title }, tx.id);
            return updated;
        });
    }

    /**
     * Buyer approves (→ release instruction, subject to release controls) or requests changes.
     * Approval never moves money by itself: it creates an authorised instruction the partner executes.
     */
    async review(actor: Actor, transactionId: string, milestoneId: string, rawInput: unknown) {
        const parsed = milestoneDecisionSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid decision', { issues: parsed.error.issues });
        const input = parsed.data;
        if (input.decision === 'REQUEST_CHANGES' && !input.reason) throw new AppError('VALIDATION', 'Explain what must be changed');
        const result = await this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId, { roles: ['BUYER'], write: true });
            const milestone = await db.milestones.get(milestoneId);
            if (!milestone || milestone.transactionId !== tx.id) throw notFound('Milestone');
            if (milestone.status !== 'SUBMITTED') throw new AppError('PRECONDITION_FAILED', 'This milestone is not awaiting review');
            const now = this.deps.clock.now().toISOString();
            let updated = await this.workflow.transition(db, tx, 'MILESTONE_REVIEWED', 'BUYER', actor, {
                metadata: { milestoneId, decision: input.decision }
            });
            const seller = await db.transactionParties.findOne({ transactionId, role: 'SELLER' });
            let blockers: ReleaseBlocker[] = [];
            if (input.decision === 'APPROVE') {
                const approved = await db.milestones.update(milestoneId, { status: 'APPROVED', decidedAt: now, decidedBy: actor.userId });
                await audit(this.deps, db, actor, 'milestone.approved', { type: 'milestone', id: milestoneId }, { transactionId: tx.id });
                ({ blockers } = await this.payments.releaseForMilestoneInTx(db, actor, updated, approved));
                await this.workflow.activateNextMilestone(db, updated);
                await notify(
                    this.deps,
                    db,
                    seller?.userId,
                    'milestone.approved',
                    { reference: tx.reference, title: milestone.title },
                    tx.id
                );
            } else {
                await db.milestones.update(milestoneId, {
                    status: 'CHANGES_REQUESTED',
                    decidedAt: now,
                    decidedBy: actor.userId,
                    changeRequestReason: input.reason
                });
                await audit(
                    this.deps,
                    db,
                    actor,
                    'milestone.changes_requested',
                    { type: 'milestone', id: milestoneId },
                    { transactionId: tx.id }
                );
                await notify(
                    this.deps,
                    db,
                    seller?.userId,
                    'milestone.changes_requested',
                    { reference: tx.reference, title: milestone.title },
                    tx.id
                );
            }
            updated = (await db.transactions.get(tx.id))!;
            return { transaction: updated, releaseBlockers: blockers };
        });
        await this.payments.dispatchPending(transactionId);
        return result;
    }

    assertSeller(role?: string) {
        if (role !== 'SELLER') throw forbidden();
    }
}
