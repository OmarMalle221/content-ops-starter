// Runtime enums shared by API and web. They mirror the Prisma enums 1:1 so the
// web app never needs to depend on the Prisma client.

export const GlobalRole = { USER: 'USER', COMPLIANCE: 'COMPLIANCE', ADMIN: 'ADMIN' } as const;
export type GlobalRole = (typeof GlobalRole)[keyof typeof GlobalRole];

export const OrgRole = { OWNER: 'OWNER', ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' } as const;
export type OrgRole = (typeof OrgRole)[keyof typeof OrgRole];

export const OrganizationType = { PERSONAL: 'PERSONAL', BUSINESS: 'BUSINESS' } as const;
export type OrganizationType = (typeof OrganizationType)[keyof typeof OrganizationType];

export const VerificationStatus = {
  NOT_STARTED: 'NOT_STARTED',
  PENDING: 'PENDING',
  SIMULATED_PASS: 'SIMULATED_PASS',
  SIMULATED_FAIL: 'SIMULATED_FAIL',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

export const TransactionStatus = {
  DRAFT: 'DRAFT',
  PENDING_ACCEPTANCE: 'PENDING_ACCEPTANCE',
  ACCEPTED: 'ACCEPTED',
  AWAITING_FUNDING: 'AWAITING_FUNDING',
  FUNDED: 'FUNDED',
  IN_PROGRESS: 'IN_PROGRESS',
  DISPUTED: 'DISPUTED',
  SETTLED: 'SETTLED',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const TransactionCategory = {
  VEHICLE: 'VEHICLE',
  GOODS: 'GOODS',
  SERVICES: 'SERVICES',
  REAL_ESTATE: 'REAL_ESTATE',
  OTHER: 'OTHER',
} as const;
export type TransactionCategory = (typeof TransactionCategory)[keyof typeof TransactionCategory];

export const PartyRole = { BUYER: 'BUYER', SELLER: 'SELLER' } as const;
export type PartyRole = (typeof PartyRole)[keyof typeof PartyRole];

export const PartyStatus = {
  INVITED: 'INVITED',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
} as const;
export type PartyStatus = (typeof PartyStatus)[keyof typeof PartyStatus];

export const ContractStatus = {
  DRAFT: 'DRAFT',
  PENDING_ACCEPTANCE: 'PENDING_ACCEPTANCE',
  ACCEPTED: 'ACCEPTED',
  SUPERSEDED: 'SUPERSEDED',
  VOID: 'VOID',
} as const;
export type ContractStatus = (typeof ContractStatus)[keyof typeof ContractStatus];

export const MilestoneStatus = {
  PENDING: 'PENDING',
  SUBMITTED: 'SUBMITTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  APPROVED: 'APPROVED',
  RELEASED: 'RELEASED',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
} as const;
export type MilestoneStatus = (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

export const DocumentKind = {
  CONTRACT: 'CONTRACT',
  INVOICE: 'INVOICE',
  PROFORMA: 'PROFORMA',
  IDENTITY: 'IDENTITY',
  BUSINESS_REGISTRATION: 'BUSINESS_REGISTRATION',
  PROOF_OF_SHIPMENT: 'PROOF_OF_SHIPMENT',
  BILL_OF_LADING: 'BILL_OF_LADING',
  CUSTOMS: 'CUSTOMS',
  INSPECTION_REPORT: 'INSPECTION_REPORT',
  PHOTO: 'PHOTO',
  RECEIPT: 'RECEIPT',
  OTHER: 'OTHER',
} as const;
export type DocumentKind = (typeof DocumentKind)[keyof typeof DocumentKind];

export const DocumentStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const DisputeStatus = {
  OPEN: 'OPEN',
  UNDER_REVIEW: 'UNDER_REVIEW',
  DECIDED: 'DECIDED',
  APPEALED: 'APPEALED',
  CLOSED: 'CLOSED',
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

export const DisputeReason = {
  NOT_DELIVERED: 'NOT_DELIVERED',
  NOT_AS_DESCRIBED: 'NOT_AS_DESCRIBED',
  DAMAGED: 'DAMAGED',
  DOCUMENT_MISMATCH: 'DOCUMENT_MISMATCH',
  PAYMENT_ISSUE: 'PAYMENT_ISSUE',
  OTHER: 'OTHER',
} as const;
export type DisputeReason = (typeof DisputeReason)[keyof typeof DisputeReason];

export const DisputeOutcome = {
  RELEASE_TO_SELLER: 'RELEASE_TO_SELLER',
  REFUND_TO_BUYER: 'REFUND_TO_BUYER',
  SPLIT: 'SPLIT',
  DISMISSED: 'DISMISSED',
} as const;
export type DisputeOutcome = (typeof DisputeOutcome)[keyof typeof DisputeOutcome];

export const FundingStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type FundingStatus = (typeof FundingStatus)[keyof typeof FundingStatus];

export const TransferStatus = {
  CREATED: 'CREATED',
  QUOTED: 'QUOTED',
  AUTHORIZED: 'AUTHORIZED',
  PROCESSING: 'PROCESSING',
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
} as const;
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

export const RiskSeverity = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } as const;
export type RiskSeverity = (typeof RiskSeverity)[keyof typeof RiskSeverity];

export const RiskAlertStatus = {
  OPEN: 'OPEN',
  REVIEWING: 'REVIEWING',
  CONFIRMED: 'CONFIRMED',
  DISMISSED: 'DISMISSED',
  CONTESTED: 'CONTESTED',
} as const;
export type RiskAlertStatus = (typeof RiskAlertStatus)[keyof typeof RiskAlertStatus];

export const LedgerAccountType = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  EQUITY: 'EQUITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSE',
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

export const BalanceSide = { DEBIT: 'DEBIT', CREDIT: 'CREDIT' } as const;
export type BalanceSide = (typeof BalanceSide)[keyof typeof BalanceSide];

export const LedgerTransactionKind = {
  DEPOSIT: 'DEPOSIT',
  FUNDING: 'FUNDING',
  RELEASE: 'RELEASE',
  FEE: 'FEE',
  REFUND: 'REFUND',
  REVERSAL: 'REVERSAL',
  ADJUSTMENT: 'ADJUSTMENT',
  WITHDRAWAL: 'WITHDRAWAL',
} as const;
export type LedgerTransactionKind = (typeof LedgerTransactionKind)[keyof typeof LedgerTransactionKind];

/** Transaction event types written to the immutable transaction history. */
export const TransactionEventType = {
  CREATED: 'transaction.created',
  PARTY_INVITED: 'transaction.party_invited',
  PARTY_ACCEPTED: 'transaction.party_accepted',
  PARTY_DECLINED: 'transaction.party_declined',
  CONTRACT_GENERATED: 'contract.generated',
  CONTRACT_ACCEPTED: 'contract.accepted',
  VERIFICATION_REQUIRED: 'verification.required',
  VERIFICATION_COMPLETED: 'verification.completed',
  FUNDING_REQUESTED: 'funding.requested',
  FUNDING_CONFIRMED: 'funding.confirmed',
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_REVIEWED: 'document.reviewed',
  MILESTONE_SUBMITTED: 'milestone.submitted',
  MILESTONE_CHANGES_REQUESTED: 'milestone.changes_requested',
  MILESTONE_APPROVED: 'milestone.approved',
  MILESTONE_RELEASED: 'milestone.released',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_UNDER_REVIEW: 'dispute.under_review',
  DISPUTE_DECIDED: 'dispute.decided',
  DISPUTE_APPEALED: 'dispute.appealed',
  DISPUTE_CLOSED: 'dispute.closed',
  RELEASE_FROZEN: 'release.frozen',
  RELEASE_UNFROZEN: 'release.unfrozen',
  REFUND_REQUESTED: 'refund.requested',
  REFUNDED: 'transaction.refunded',
  SETTLED: 'transaction.settled',
  CANCELLED: 'transaction.cancelled',
  EXPIRED: 'transaction.expired',
} as const;
export type TransactionEventType = (typeof TransactionEventType)[keyof typeof TransactionEventType];
