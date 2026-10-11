import { DisputeStatus, FundingStatus, MilestoneStatus, TransactionStatus, TransferStatus } from '../enums';
import { defineStateMachine } from './machine';

export * from './machine';

/**
 * Diaspora Protect transaction lifecycle.
 *
 * DRAFT → PENDING_ACCEPTANCE → ACCEPTED → AWAITING_FUNDING → FUNDED → IN_PROGRESS → SETTLED
 * Any funded state may enter DISPUTED, which freezes releases until a decision.
 */
export const transactionMachine = defineStateMachine<TransactionStatus>('Transaction', {
  DRAFT: ['PENDING_ACCEPTANCE', 'CANCELLED'],
  PENDING_ACCEPTANCE: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['AWAITING_FUNDING', 'CANCELLED'],
  AWAITING_FUNDING: ['FUNDED', 'CANCELLED', 'EXPIRED'],
  FUNDED: ['IN_PROGRESS', 'DISPUTED', 'REFUNDED', 'SETTLED'],
  IN_PROGRESS: ['DISPUTED', 'SETTLED', 'REFUNDED'],
  DISPUTED: ['IN_PROGRESS', 'FUNDED', 'SETTLED', 'REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: [],
});

export const milestoneMachine = defineStateMachine<MilestoneStatus>('Milestone', {
  PENDING: ['SUBMITTED', 'CANCELLED', 'REFUNDED'],
  SUBMITTED: ['APPROVED', 'CHANGES_REQUESTED', 'CANCELLED', 'REFUNDED'],
  CHANGES_REQUESTED: ['SUBMITTED', 'CANCELLED', 'REFUNDED'],
  APPROVED: ['RELEASED', 'REFUNDED'],
  RELEASED: [],
  REFUNDED: [],
  CANCELLED: [],
});

export const disputeMachine = defineStateMachine<DisputeStatus>('Dispute', {
  OPEN: ['UNDER_REVIEW', 'CLOSED'],
  UNDER_REVIEW: ['DECIDED', 'CLOSED'],
  DECIDED: ['APPEALED', 'CLOSED'],
  APPEALED: ['DECIDED', 'CLOSED'],
  CLOSED: [],
});

export const fundingMachine = defineStateMachine<FundingStatus>('FundingRequest', {
  PENDING: ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
});

/** Diaspora Transfer (Phase 4). Defined now so the contract is stable. */
export const transferMachine = defineStateMachine<TransferStatus>('Transfer', {
  CREATED: ['QUOTED', 'CANCELLED', 'EXPIRED'],
  QUOTED: ['AUTHORIZED', 'EXPIRED', 'CANCELLED', 'REVIEW_REQUIRED'],
  AUTHORIZED: ['PROCESSING', 'CANCELLED', 'REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['AUTHORIZED', 'CANCELLED', 'FAILED'],
  PROCESSING: ['SETTLED', 'FAILED'],
  SETTLED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
});

/** States in which escrowed funds exist and a dispute may be opened. */
export const DISPUTABLE_TRANSACTION_STATES: TransactionStatus[] = ['FUNDED', 'IN_PROGRESS'];

/** States in which a transaction can still be cancelled by a party without funds movement. */
export const CANCELLABLE_TRANSACTION_STATES: TransactionStatus[] = [
  'DRAFT',
  'PENDING_ACCEPTANCE',
  'ACCEPTED',
  'AWAITING_FUNDING',
];
