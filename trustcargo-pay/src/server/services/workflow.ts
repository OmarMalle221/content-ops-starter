/**
 * Bridges the pure state machine with persisted facts. All status changes go through `transition`,
 * which evaluates guards, applies an optimistic-locked update and appends the audit event in the
 * caller's unit of work.
 */
import { evaluateTransition, type TransitionActor, type TransitionContext, type TransitionId } from '@/domain/transaction/state-machine';
import { checkVin } from '@/domain/vehicle/vin';
import { totalShareBps } from '@/domain/transaction/contract';
import type { Milestone, Transaction } from '@/domain/model';
import type { Db } from '@/server/ports/db';
import type { AnyActor } from '@/server/auth/actor';
import { SYSTEM } from '@/server/auth/actor';
import { AppError } from '@/server/errors';
import { audit, type Deps } from './context';
import type { LedgerService } from './ledger-service';

const LIVE_DOC = (status: string) =>
    status !== 'SUPERSEDED' && status !== 'REJECTED' && status !== 'QUARANTINED' && status !== 'SCAN_PENDING';

export function activeMilestone(milestones: Milestone[]): Milestone | undefined {
    return milestones.filter((m) => m.status === 'ACTIVE' || m.status === 'CHANGES_REQUESTED').sort((a, b) => a.sequence - b.sequence)[0];
}

export async function currentMilestones(db: Db, tx: Transaction): Promise<Milestone[]> {
    if (!tx.currentContractVersionId) return [];
    return (await db.milestones.findBy({ transactionId: tx.id, contractVersionId: tx.currentContractVersionId })).sort(
        (a, b) => a.sequence - b.sequence
    );
}

export class Workflow {
    constructor(
        private readonly deps: Deps,
        private readonly ledger: LedgerService
    ) {}

    async buildContext(db: Db, tx: Transaction, extra: Partial<TransitionContext> = {}): Promise<TransitionContext> {
        const parties = await db.transactionParties.findBy({ transactionId: tx.id });
        const principals = parties.filter((p) => p.role === 'SELLER' || p.role === 'BUYER');
        const users = await Promise.all(principals.map((p) => (p.userId ? db.users.get(p.userId) : undefined)));
        const vehicle = await db.vehicles.findOne({ transactionId: tx.id });
        const corridor = await db.corridors.get(tx.corridorId);
        const milestones = (await currentMilestones(db, tx)).filter((m) => m.status !== 'CANCELLED');
        const acceptances = tx.currentContractVersionId
            ? await db.contractAcceptances.findBy({ contractVersionId: tx.currentContractVersionId })
            : [];
        const version = tx.currentContractVersionId ? await db.contractVersions.get(tx.currentContractVersionId) : undefined;
        const instructions = await db.paymentInstructions.findBy({ transactionId: tx.id });
        const holds = await db.complianceHolds.findBy({ transactionId: tx.id, status: 'ACTIVE' });
        const disputes = await db.disputes.findBy({ transactionId: tx.id });
        const payouts = await db.payouts.findBy({ transactionId: tx.id });
        const refunds = await db.refunds.findBy({ transactionId: tx.id });
        const active = activeMilestone(milestones);
        let evidenceOk = false;
        if (active) {
            const evidence = await db.milestoneEvidence.findBy({ milestoneId: active.id });
            const docs = (await Promise.all(evidence.map((e) => db.documents.get(e.documentId)))).filter((d) => d && LIVE_DOC(d.status));
            evidenceOk = active.requiredEvidence.every((t) => docs.some((d) => d!.type === t));
        }
        const held = await this.ledger.balance(db, `TX_HELD:${tx.id}:${tx.amount.currency}`);

        return {
            status: tx.status,
            statusBeforeDispute: tx.statusBeforeDispute,
            hasContractVersion: Boolean(version),
            milestonesShareBps: totalShareBps(milestones),
            vehicleValid: tx.type !== 'VEHICLE_PURCHASE' || (vehicle !== undefined && checkVin(vehicle.vin).structurallyValid),
            corridorEnabled: corridor?.enabled ?? false,
            counterpartyJoined: parties.some((p) => p.role === 'BUYER' && p.status === 'JOINED'),
            allPartiesKycVerified: principals.length >= 2 && users.every((u) => u?.kycStatus === 'VERIFIED'),
            currentContractAcceptedByAll:
                principals.length >= 2 &&
                principals.every((p) =>
                    acceptances.some((a) => a.partyId === p.id && a.decision === 'ACCEPTED' && a.contentHash === version?.contentHash)
                ),
            fundingStarted: instructions.some((i) => i.status === 'PENDING' || i.status === 'FUNDED'),
            hasOpenPaymentInstruction: instructions.some((i) => i.status === 'CREATED' || i.status === 'PENDING' || i.status === 'FUNDED'),
            reportedAmountMatches: false,
            ledgerHeldEqualsTotal: held === tx.amount.amountMinor,
            activeMilestoneHasRequiredEvidence: evidenceOk,
            hasActiveMilestone: Boolean(active),
            hasSubmittedMilestone: milestones.some((m) => m.status === 'SUBMITTED'),
            activeComplianceHold: holds.length > 0,
            openDispute: disputes.some((d) => !['RESOLVED', 'WITHDRAWN', 'ARCHIVED'].includes(d.status)),
            recentMfa: false,
            allMilestonesReleased: milestones.length > 0 && milestones.every((m) => m.status === 'RELEASED'),
            settlementsPending:
                payouts.some((p) => ['REQUESTED', 'SUBMITTED', 'PROCESSING', 'FAILED'].includes(p.status)) ||
                refunds.some((r) => ['REQUESTED', 'SUBMITTED', 'PROCESSING', 'FAILED'].includes(r.status)),
            ...extra
        };
    }

    /** Applies a transition or throws PRECONDITION_FAILED with the failing guard codes. */
    async transition(
        db: Db,
        tx: Transaction,
        id: TransitionId,
        actorKind: TransitionActor,
        actor: AnyActor,
        options: { extra?: Partial<TransitionContext>; patch?: Partial<Transaction>; metadata?: Record<string, unknown> } = {}
    ): Promise<Transaction> {
        const ctx = await this.buildContext(db, tx, options.extra);
        const result = evaluateTransition(id, actorKind, ctx);
        if (!result.ok) {
            throw new AppError(
                result.reason === 'ACTOR_NOT_ALLOWED' ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
                `Transition ${id} not allowed: ${result.reason}`,
                {
                    transition: id,
                    reason: result.reason,
                    failedGuards: result.failedGuards,
                    status: tx.status
                }
            );
        }
        const now = this.deps.clock.now().toISOString();
        const updated = await db.transactions.update(
            tx.id,
            { ...options.patch, status: result.to, updatedAt: now },
            { expectedVersion: tx.version }
        );
        await audit(
            this.deps,
            db,
            actor,
            result.auditAction,
            { type: 'transaction', id: tx.id },
            {
                transactionId: tx.id,
                metadata: { from: result.from, to: result.to, transition: id, ...options.metadata }
            }
        );
        return updated;
    }

    /**
     * Idempotent "system" progression: applies every automatic transition whose guards now pass.
     * Safe to call after any fact changes (RETRY_IDEMPOTENT recovery policy).
     */
    async autoAdvance(db: Db, transactionId: string): Promise<Transaction> {
        const automatic: TransitionId[] = [
            'COUNTERPARTY_JOINED',
            'IDENTITIES_VERIFIED',
            'CONTRACT_AGREED',
            'WORK_STARTED',
            'SETTLED',
            'REFUND_SETTLED'
        ];
        let tx = (await db.transactions.get(transactionId))!;
        for (let i = 0; i < automatic.length + 1; i++) {
            if (tx.status === 'FUNDS_CONFIRMED') await this.activateNextMilestone(db, tx);
            const ctx = await this.buildContext(db, tx);
            const next = automatic.find((id) => evaluateTransition(id, 'SYSTEM', ctx).ok);
            if (!next) break;
            const patch: Partial<Transaction> = {};
            if (next === 'SETTLED' || next === 'REFUND_SETTLED') patch.closedAt = this.deps.clock.now().toISOString();
            tx = await this.transition(db, tx, next, 'SYSTEM', SYSTEM, { patch });
        }
        return tx;
    }

    async activateNextMilestone(db: Db, tx: Transaction) {
        const milestones = await currentMilestones(db, tx);
        if (milestones.some((m) => ['ACTIVE', 'CHANGES_REQUESTED', 'SUBMITTED'].includes(m.status))) return;
        const next = milestones.find((m) => m.status === 'PENDING');
        if (next) {
            await db.milestones.update(next.id, { status: 'ACTIVE' });
            await audit(
                this.deps,
                db,
                SYSTEM,
                'milestone.activated',
                { type: 'milestone', id: next.id },
                { transactionId: tx.id, metadata: { sequence: next.sequence } }
            );
        }
    }
}
