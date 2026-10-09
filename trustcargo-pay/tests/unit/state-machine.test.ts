import { describe, expect, it } from 'vitest';
import {
    evaluateTransition,
    getTransition,
    TRANSITIONS,
    type TransitionContext,
    type TransitionId
} from '@/domain/transaction/state-machine';
import { TRANSACTION_STATUSES } from '@/domain/model';

const ok: TransitionContext = {
    status: 'DRAFT',
    hasContractVersion: true,
    milestonesShareBps: 10_000,
    vehicleValid: true,
    corridorEnabled: true,
    counterpartyJoined: true,
    allPartiesKycVerified: true,
    currentContractAcceptedByAll: true,
    fundingStarted: false,
    hasOpenPaymentInstruction: true,
    reportedAmountMatches: true,
    ledgerHeldEqualsTotal: true,
    activeMilestoneHasRequiredEvidence: true,
    hasActiveMilestone: true,
    hasSubmittedMilestone: true,
    activeComplianceHold: false,
    openDispute: false,
    recentMfa: true,
    allMilestonesReleased: true,
    settlementsPending: false
};

describe('transaction state machine', () => {
    it('walks the happy path with the authorised actors only', () => {
        const path: [TransitionId, TransitionContext['status'], Parameters<typeof evaluateTransition>[1], string][] = [
            ['SEND_INVITATIONS', 'DRAFT', 'SELLER', 'AWAITING_PARTIES'],
            ['COUNTERPARTY_JOINED', 'AWAITING_PARTIES', 'SYSTEM', 'IDENTITY_VERIFICATION'],
            ['IDENTITIES_VERIFIED', 'IDENTITY_VERIFICATION', 'SYSTEM', 'AWAITING_AGREEMENT'],
            ['CONTRACT_AGREED', 'AWAITING_AGREEMENT', 'SYSTEM', 'AWAITING_FUNDING'],
            ['FUNDING_INITIATED', 'AWAITING_FUNDING', 'PROVIDER', 'FUNDING_PENDING'],
            ['FUNDS_CONFIRMED', 'FUNDING_PENDING', 'PROVIDER', 'FUNDS_CONFIRMED'],
            ['WORK_STARTED', 'FUNDS_CONFIRMED', 'SYSTEM', 'IN_PROGRESS'],
            ['MILESTONE_SUBMITTED', 'IN_PROGRESS', 'SELLER', 'MILESTONE_REVIEW'],
            ['MILESTONE_REVIEWED', 'MILESTONE_REVIEW', 'BUYER', 'IN_PROGRESS'],
            ['SETTLED', 'IN_PROGRESS', 'SYSTEM', 'COMPLETED']
        ];
        for (const [id, from, actor, to] of path) {
            const r = evaluateTransition(id, actor, { ...ok, status: from });
            expect(r, id).toMatchObject({ ok: true, to });
        }
    });

    it('never lets a party (browser) confirm funds or trigger a financial transition', () => {
        const financial = (Object.keys(TRANSITIONS) as TransitionId[]).filter((id) => getTransition(id).financial);
        expect(financial.sort()).toEqual(['FUNDING_FAILED', 'FUNDING_INITIATED', 'FUNDS_CONFIRMED']);
        for (const id of financial) {
            expect(getTransition(id).actors).toEqual(['PROVIDER']);
            for (const actor of ['SELLER', 'BUYER', 'SYSTEM', 'DISPUTE_MANAGER', 'COMPLIANCE'] as const) {
                const r = evaluateTransition(id, actor, { ...ok, status: getTransition(id).from[0]! });
                expect(r).toMatchObject({ ok: false, reason: 'ACTOR_NOT_ALLOWED' });
            }
        }
    });

    it('rejects funds confirmation when the reported amount differs', () => {
        const r = evaluateTransition('FUNDS_CONFIRMED', 'PROVIDER', { ...ok, status: 'FUNDING_PENDING', reportedAmountMatches: false });
        expect(r).toEqual({ ok: false, transition: 'FUNDS_CONFIRMED', reason: 'GUARD_FAILED', failedGuards: ['AMOUNT_MISMATCH'] });
    });

    it('reports every failing guard to explain the block', () => {
        const r = evaluateTransition('SEND_INVITATIONS', 'SELLER', { ...ok, milestonesShareBps: 9000, vehicleValid: false });
        expect(r).toMatchObject({ ok: false, failedGuards: ['MILESTONES_NOT_100_PERCENT', 'VEHICLE_INVALID'] });
    });

    it('rejects transitions from invalid source states', () => {
        expect(evaluateTransition('SETTLED', 'SYSTEM', { ...ok, status: 'AWAITING_FUNDING' })).toMatchObject({
            ok: false,
            reason: 'INVALID_SOURCE_STATE'
        });
        expect(evaluateTransition('CANCEL', 'SELLER', { ...ok, status: 'IN_PROGRESS' })).toMatchObject({
            ok: false,
            reason: 'INVALID_SOURCE_STATE'
        });
    });

    it('blocks milestone submission under a compliance hold and dispute decisions without MFA', () => {
        expect(
            evaluateTransition('MILESTONE_SUBMITTED', 'SELLER', { ...ok, status: 'IN_PROGRESS', activeComplianceHold: true })
        ).toMatchObject({
            failedGuards: ['COMPLIANCE_HOLD_ACTIVE']
        });
        expect(
            evaluateTransition('DISPUTE_REFUND_ORDERED', 'DISPUTE_MANAGER', { ...ok, status: 'DISPUTED', recentMfa: false })
        ).toMatchObject({
            failedGuards: ['MFA_REQUIRED']
        });
    });

    it('restores the pre-dispute state on resume', () => {
        expect(
            evaluateTransition('DISPUTE_RESUMED', 'DISPUTE_MANAGER', { ...ok, status: 'DISPUTED', statusBeforeDispute: 'MILESTONE_REVIEW' })
        ).toMatchObject({ ok: true, to: 'MILESTONE_REVIEW' });
        expect(
            evaluateTransition('DISPUTE_RESUMED', 'DISPUTE_MANAGER', {
                ...ok,
                status: 'DISPUTED',
                statusBeforeDispute: 'IN_PROGRESS',
                hasSubmittedMilestone: false
            })
        ).toMatchObject({ ok: true, to: 'IN_PROGRESS' });
    });

    it('has a definition (audit action, recovery policy) for every transition and reaches every status', () => {
        const reached = new Set<string>(['DRAFT']);
        for (const id of Object.keys(TRANSITIONS) as TransitionId[]) {
            const def = getTransition(id);
            expect(def.auditAction).toMatch(/^transaction\./);
            expect(def.recovery).toBeTruthy();
            def.targets.forEach((t) => reached.add(t));
        }
        expect([...reached].sort()).toEqual([...TRANSACTION_STATUSES].sort());
    });
});
