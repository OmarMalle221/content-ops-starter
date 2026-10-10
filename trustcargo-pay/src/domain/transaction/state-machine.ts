/**
 * Transaction workflow engine.
 *
 * Every transition is declared as data: source states, target state, authorised actors, guards
 * (entry conditions), the audit action / business event it emits, and its recovery policy.
 * The engine is pure: services build the `TransitionContext` from persisted facts, call `evaluate`
 * and persist the result together with the audit event in a single unit of work.
 *
 * Financial transitions (FUNDING_*, FUNDS_CONFIRMED) are only reachable by the PROVIDER actor,
 * which services only use after verifying a signed partner event. A browser can never trigger them.
 */
import type { PayoutStatus, RefundStatus, TransactionStatus } from '../model';

export type TransitionActor = 'SELLER' | 'BUYER' | 'SYSTEM' | 'PROVIDER' | 'DISPUTE_MANAGER' | 'COMPLIANCE';

export type RecoveryPolicy =
    /** Safe to retry automatically: the transition is idempotent and guarded. */
    | 'RETRY_IDEMPOTENT'
    /** On failure, the operation is parked and surfaced to operations staff. */
    | 'MANUAL_REVIEW'
    /** User-initiated; on failure the user is shown the failing preconditions and may retry. */
    | 'USER_RETRY';

export type GuardCode =
    | 'CONTRACT_MISSING'
    | 'MILESTONES_NOT_100_PERCENT'
    | 'VEHICLE_INVALID'
    | 'CORRIDOR_DISABLED'
    | 'COUNTERPARTY_NOT_JOINED'
    | 'KYC_INCOMPLETE'
    | 'CONTRACT_NOT_ACCEPTED_BY_ALL'
    | 'FUNDING_ALREADY_STARTED'
    | 'NO_PAYMENT_INSTRUCTION'
    | 'AMOUNT_MISMATCH'
    | 'LEDGER_NOT_FUNDED'
    | 'MISSING_REQUIRED_EVIDENCE'
    | 'NO_ACTIVE_MILESTONE'
    | 'NO_SUBMITTED_MILESTONE'
    | 'COMPLIANCE_HOLD_ACTIVE'
    | 'DISPUTE_ALREADY_OPEN'
    | 'MFA_REQUIRED'
    | 'MILESTONES_NOT_SETTLED'
    | 'SETTLEMENT_PENDING'
    | 'NO_PRIOR_STATUS';

/** Facts gathered by the service layer. Each guard reads only what it needs. */
export interface TransitionContext {
    status: TransactionStatus;
    statusBeforeDispute?: TransactionStatus;
    hasContractVersion: boolean;
    milestonesShareBps: number;
    vehicleValid: boolean;
    corridorEnabled: boolean;
    counterpartyJoined: boolean;
    allPartiesKycVerified: boolean;
    currentContractAcceptedByAll: boolean;
    fundingStarted: boolean;
    hasOpenPaymentInstruction: boolean;
    reportedAmountMatches: boolean;
    ledgerHeldEqualsTotal: boolean;
    activeMilestoneHasRequiredEvidence: boolean;
    hasActiveMilestone: boolean;
    hasSubmittedMilestone: boolean;
    activeComplianceHold: boolean;
    openDispute: boolean;
    recentMfa: boolean;
    allMilestonesReleased: boolean;
    settlementsPending: boolean;
}

export type Guard = { code: GuardCode; check: (ctx: TransitionContext) => boolean };

export interface TransitionDefinition {
    id: TransitionId;
    from: readonly TransactionStatus[];
    /** Static target, or a resolver for transitions whose target depends on facts (documented in `targets`). */
    to: TransactionStatus | ((ctx: TransitionContext) => TransactionStatus);
    targets: readonly TransactionStatus[];
    actors: readonly TransitionActor[];
    guards: readonly Guard[];
    auditAction: string;
    recovery: RecoveryPolicy;
    /** Financial transitions require an authenticated partner event. */
    financial: boolean;
}

const g = {
    contract: { code: 'CONTRACT_MISSING', check: (c) => c.hasContractVersion },
    milestones100: { code: 'MILESTONES_NOT_100_PERCENT', check: (c) => c.milestonesShareBps === 10_000 },
    vehicle: { code: 'VEHICLE_INVALID', check: (c) => c.vehicleValid },
    corridor: { code: 'CORRIDOR_DISABLED', check: (c) => c.corridorEnabled },
    joined: { code: 'COUNTERPARTY_NOT_JOINED', check: (c) => c.counterpartyJoined },
    kyc: { code: 'KYC_INCOMPLETE', check: (c) => c.allPartiesKycVerified },
    accepted: { code: 'CONTRACT_NOT_ACCEPTED_BY_ALL', check: (c) => c.currentContractAcceptedByAll },
    notFunding: { code: 'FUNDING_ALREADY_STARTED', check: (c) => !c.fundingStarted },
    instruction: { code: 'NO_PAYMENT_INSTRUCTION', check: (c) => c.hasOpenPaymentInstruction },
    amount: { code: 'AMOUNT_MISMATCH', check: (c) => c.reportedAmountMatches },
    ledger: { code: 'LEDGER_NOT_FUNDED', check: (c) => c.ledgerHeldEqualsTotal },
    evidence: { code: 'MISSING_REQUIRED_EVIDENCE', check: (c) => c.activeMilestoneHasRequiredEvidence },
    activeMilestone: { code: 'NO_ACTIVE_MILESTONE', check: (c) => c.hasActiveMilestone },
    submitted: { code: 'NO_SUBMITTED_MILESTONE', check: (c) => c.hasSubmittedMilestone },
    noHold: { code: 'COMPLIANCE_HOLD_ACTIVE', check: (c) => !c.activeComplianceHold },
    noDispute: { code: 'DISPUTE_ALREADY_OPEN', check: (c) => !c.openDispute },
    mfa: { code: 'MFA_REQUIRED', check: (c) => c.recentMfa },
    released: { code: 'MILESTONES_NOT_SETTLED', check: (c) => c.allMilestonesReleased },
    settled: { code: 'SETTLEMENT_PENDING', check: (c) => !c.settlementsPending },
    priorStatus: { code: 'NO_PRIOR_STATUS', check: (c) => c.statusBeforeDispute !== undefined }
} satisfies Record<string, Guard>;

export const PRE_FUNDING_STATUSES = [
    'DRAFT',
    'AWAITING_PARTIES',
    'IDENTITY_VERIFICATION',
    'AWAITING_AGREEMENT',
    'AWAITING_FUNDING'
] as const satisfies readonly TransactionStatus[];

export const TRANSITIONS = {
    SEND_INVITATIONS: {
        from: ['DRAFT'],
        to: 'AWAITING_PARTIES',
        actors: ['SELLER'],
        guards: [g.contract, g.milestones100, g.vehicle, g.corridor],
        auditAction: 'transaction.invitations_sent',
        recovery: 'USER_RETRY',
        financial: false
    },
    COUNTERPARTY_JOINED: {
        from: ['AWAITING_PARTIES'],
        to: 'IDENTITY_VERIFICATION',
        actors: ['SYSTEM'],
        guards: [g.joined],
        auditAction: 'transaction.counterparty_joined',
        recovery: 'RETRY_IDEMPOTENT',
        financial: false
    },
    IDENTITIES_VERIFIED: {
        from: ['IDENTITY_VERIFICATION'],
        to: 'AWAITING_AGREEMENT',
        actors: ['SYSTEM'],
        guards: [g.kyc],
        auditAction: 'transaction.identities_verified',
        recovery: 'RETRY_IDEMPOTENT',
        financial: false
    },
    CONTRACT_AGREED: {
        from: ['AWAITING_AGREEMENT'],
        to: 'AWAITING_FUNDING',
        actors: ['SYSTEM'],
        guards: [g.kyc, g.accepted],
        auditAction: 'transaction.contract_agreed',
        recovery: 'RETRY_IDEMPOTENT',
        financial: false
    },
    CONTRACT_AMENDED: {
        from: ['AWAITING_AGREEMENT', 'AWAITING_FUNDING'],
        to: 'AWAITING_AGREEMENT',
        actors: ['SELLER'],
        guards: [g.notFunding, g.milestones100],
        auditAction: 'transaction.contract_amended',
        recovery: 'USER_RETRY',
        financial: false
    },
    FUNDING_INITIATED: {
        from: ['AWAITING_FUNDING'],
        to: 'FUNDING_PENDING',
        actors: ['PROVIDER'],
        guards: [g.instruction, g.noHold],
        auditAction: 'transaction.funding_initiated',
        recovery: 'RETRY_IDEMPOTENT',
        financial: true
    },
    FUNDS_CONFIRMED: {
        from: ['AWAITING_FUNDING', 'FUNDING_PENDING'],
        to: 'FUNDS_CONFIRMED',
        actors: ['PROVIDER'],
        guards: [g.instruction, g.amount],
        auditAction: 'transaction.funds_confirmed',
        recovery: 'MANUAL_REVIEW',
        financial: true
    },
    FUNDING_FAILED: {
        from: ['FUNDING_PENDING'],
        to: 'AWAITING_FUNDING',
        actors: ['PROVIDER'],
        guards: [],
        auditAction: 'transaction.funding_failed',
        recovery: 'RETRY_IDEMPOTENT',
        financial: true
    },
    WORK_STARTED: {
        from: ['FUNDS_CONFIRMED'],
        to: 'IN_PROGRESS',
        actors: ['SYSTEM'],
        guards: [g.ledger, g.activeMilestone],
        auditAction: 'transaction.work_started',
        recovery: 'RETRY_IDEMPOTENT',
        financial: false
    },
    MILESTONE_SUBMITTED: {
        from: ['IN_PROGRESS'],
        to: 'MILESTONE_REVIEW',
        actors: ['SELLER'],
        guards: [g.activeMilestone, g.evidence, g.noHold],
        auditAction: 'transaction.milestone_submitted',
        recovery: 'USER_RETRY',
        financial: false
    },
    MILESTONE_REVIEWED: {
        from: ['MILESTONE_REVIEW'],
        to: 'IN_PROGRESS',
        actors: ['BUYER'],
        guards: [g.submitted],
        auditAction: 'transaction.milestone_reviewed',
        recovery: 'USER_RETRY',
        financial: false
    },
    SETTLED: {
        from: ['IN_PROGRESS'],
        to: 'COMPLETED',
        actors: ['SYSTEM'],
        guards: [g.released, g.settled],
        auditAction: 'transaction.completed',
        recovery: 'RETRY_IDEMPOTENT',
        financial: false
    },
    DISPUTE_OPENED: {
        from: ['FUNDS_CONFIRMED', 'IN_PROGRESS', 'MILESTONE_REVIEW'],
        to: 'DISPUTED',
        actors: ['BUYER', 'SELLER'],
        guards: [g.noDispute],
        auditAction: 'transaction.disputed',
        recovery: 'USER_RETRY',
        financial: false
    },
    DISPUTE_RESUMED: {
        from: ['DISPUTED'],
        to: (ctx) => (ctx.statusBeforeDispute === 'MILESTONE_REVIEW' && ctx.hasSubmittedMilestone ? 'MILESTONE_REVIEW' : 'IN_PROGRESS'),
        targets: ['IN_PROGRESS', 'MILESTONE_REVIEW'],
        actors: ['DISPUTE_MANAGER'],
        guards: [g.mfa, g.priorStatus],
        auditAction: 'transaction.dispute_resumed',
        recovery: 'USER_RETRY',
        financial: false
    },
    DISPUTE_WITHDRAWN: {
        from: ['DISPUTED'],
        to: (ctx) => (ctx.statusBeforeDispute === 'MILESTONE_REVIEW' && ctx.hasSubmittedMilestone ? 'MILESTONE_REVIEW' : 'IN_PROGRESS'),
        targets: ['IN_PROGRESS', 'MILESTONE_REVIEW'],
        actors: ['BUYER', 'SELLER'],
        guards: [g.priorStatus],
        auditAction: 'transaction.dispute_withdrawn',
        recovery: 'USER_RETRY',
        financial: false
    },
    DISPUTE_RELEASE_ORDERED: {
        from: ['DISPUTED'],
        to: 'IN_PROGRESS',
        actors: ['DISPUTE_MANAGER'],
        guards: [g.mfa, g.noHold],
        auditAction: 'transaction.dispute_release_ordered',
        recovery: 'MANUAL_REVIEW',
        financial: false
    },
    DISPUTE_REFUND_ORDERED: {
        from: ['DISPUTED'],
        to: 'REFUND_PENDING',
        actors: ['DISPUTE_MANAGER'],
        guards: [g.mfa, g.noHold],
        auditAction: 'transaction.dispute_refund_ordered',
        recovery: 'MANUAL_REVIEW',
        financial: false
    },
    REFUND_SETTLED: {
        from: ['REFUND_PENDING'],
        to: 'REFUNDED',
        actors: ['SYSTEM'],
        guards: [g.settled],
        auditAction: 'transaction.refunded',
        recovery: 'RETRY_IDEMPOTENT',
        financial: false
    },
    CANCEL: {
        from: PRE_FUNDING_STATUSES,
        to: 'CANCELLED',
        actors: ['SELLER', 'BUYER', 'COMPLIANCE'],
        guards: [g.notFunding],
        auditAction: 'transaction.cancelled',
        recovery: 'USER_RETRY',
        financial: false
    }
} as const satisfies Record<string, Omit<TransitionDefinition, 'id' | 'targets'> & { targets?: readonly TransactionStatus[] }>;

export type TransitionId = keyof typeof TRANSITIONS;

export function getTransition(id: TransitionId): TransitionDefinition {
    const def = TRANSITIONS[id] as Omit<TransitionDefinition, 'id' | 'targets'> & { targets?: readonly TransactionStatus[] };
    const targets = def.targets ?? [def.to as TransactionStatus];
    return { ...def, id, targets };
}

export type TransitionResult =
    | { ok: true; transition: TransitionId; from: TransactionStatus; to: TransactionStatus; auditAction: string }
    | {
          ok: false;
          transition: TransitionId;
          reason: 'INVALID_SOURCE_STATE' | 'ACTOR_NOT_ALLOWED' | 'GUARD_FAILED';
          failedGuards: GuardCode[];
      };

export function evaluateTransition(id: TransitionId, actor: TransitionActor, ctx: TransitionContext): TransitionResult {
    const def = getTransition(id);
    if (!def.from.includes(ctx.status)) {
        return { ok: false, transition: id, reason: 'INVALID_SOURCE_STATE', failedGuards: [] };
    }
    if (!def.actors.includes(actor)) {
        return { ok: false, transition: id, reason: 'ACTOR_NOT_ALLOWED', failedGuards: [] };
    }
    const failedGuards = def.guards.filter((guard) => !guard.check(ctx)).map((guard) => guard.code);
    if (failedGuards.length > 0) {
        return { ok: false, transition: id, reason: 'GUARD_FAILED', failedGuards };
    }
    const to = typeof def.to === 'function' ? def.to(ctx) : def.to;
    return { ok: true, transition: id, from: ctx.status, to, auditAction: def.auditAction };
}

/** Transitions available from a status (used to render next-step hints, never to authorize). */
export function transitionsFrom(status: TransactionStatus): TransitionDefinition[] {
    return (Object.keys(TRANSITIONS) as TransitionId[]).map(getTransition).filter((t) => t.from.includes(status));
}

export const TERMINAL_STATUSES: readonly TransactionStatus[] = ['COMPLETED', 'CANCELLED', 'REFUNDED'];

export function isTerminal(status: TransactionStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}

/** Ordered happy path, used for the progress stepper. */
export const HAPPY_PATH: readonly TransactionStatus[] = [
    'DRAFT',
    'AWAITING_PARTIES',
    'IDENTITY_VERIFICATION',
    'AWAITING_AGREEMENT',
    'AWAITING_FUNDING',
    'FUNDING_PENDING',
    'FUNDS_CONFIRMED',
    'IN_PROGRESS',
    'COMPLETED'
];

/* ------------------------------------------------------------------ payouts & refunds (separate lifecycles) */
/* A FAILED transfer is never resubmitted as-is: a retry creates a new record and the failed one is CANCELLED (superseded). */

const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
    REQUESTED: ['SUBMITTED', 'FAILED', 'CANCELLED'],
    SUBMITTED: ['PROCESSING', 'PAID', 'FAILED'],
    PROCESSING: ['PAID', 'FAILED'],
    PAID: [],
    FAILED: ['CANCELLED'],
    CANCELLED: []
};

const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
    REQUESTED: ['SUBMITTED', 'FAILED', 'CANCELLED'],
    SUBMITTED: ['PROCESSING', 'REFUNDED', 'FAILED'],
    PROCESSING: ['REFUNDED', 'FAILED'],
    REFUNDED: [],
    FAILED: ['CANCELLED'],
    CANCELLED: []
};

export function canMovePayout(from: PayoutStatus, to: PayoutStatus): boolean {
    return PAYOUT_TRANSITIONS[from].includes(to);
}

export function canMoveRefund(from: RefundStatus, to: RefundStatus): boolean {
    return REFUND_TRANSITIONS[from].includes(to);
}
