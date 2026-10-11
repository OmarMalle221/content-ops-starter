export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskSignal {
  ruleCode: string;
  severity: RiskSeverity;
  /** 0–100 contribution to the overall score */
  score: number;
  explanation: {
    summary: string;
    factors: Record<string, string | number | boolean | null>;
    recommendation: string;
    /**
     * Optional itemised evidence (e.g. the operations aggregated by STRUCTURING). Scalars only,
     * money as strings, so the explanation stays JSON-safe.
     */
    evidence?: Array<Record<string, string | number | boolean | null>>;
  };
}

/** Operation kinds aggregated by the STRUCTURING rule. */
export type StructuringOperationKind = 'SELF_DEPOSIT' | 'PROTECT_FUNDING' | 'TRANSFER' | 'INVOICE_PAYMENT';

/**
 * Operations are only aggregated with operations of the same direction (funds entering the
 * platform vs. funds leaving a wallet), like the regulatory 24-hour aggregation rules.
 */
export type StructuringFlow = 'INBOUND' | 'OUTBOUND';

export interface StructuringOperation {
  kind: StructuringOperationKind;
  /** Human readable reference (transfer / funding reference, invoice number, ledger id). */
  reference: string;
  amountMinor: bigint;
  /** ISO 8601 timestamp of the operation. */
  occurredAt: string;
  /** True for the operation whose event triggered this evaluation. */
  current?: boolean;
}

export interface StructuringSubject {
  type: 'ORGANIZATION' | 'USER';
  id: string;
  /** Every operation of the subject in the window, same currency and flow (any amount). */
  operations: StructuringOperation[];
}

export interface StructuringFacts {
  currencyCode: string;
  flow: StructuringFlow;
  windowHours: number;
  /** Aggregate threshold as a nominal decimal ("10000.00"), re-scaled to the currency exponent. */
  threshold: string;
  subjects: StructuringSubject[];
}

/**
 * Facts gathered by the API before evaluation. Every field is optional so each rule
 * only fires when it has the facts it needs — rules never guess.
 */
export interface RiskFacts {
  event:
    | 'transaction.created'
    | 'transaction.funded'
    | 'milestone.approved'
    | 'dispute.opened'
    | 'auth.login_failed'
    | 'document.uploaded'
    | 'transfer.created'
    | 'transfer.authorized'
    | 'beneficiary.changed'
    | 'wallet.self_deposit'
    | 'invoice.wallet_payment';
  userId?: string;
  organizationId?: string;
  transactionId?: string;
  amountMinor?: bigint;
  currencyCode?: string;
  /** Average transaction amount of this organisation over its history (minor units) */
  averageAmountMinor?: bigint | null;
  transactionsLast24h?: number;
  transactionsLast30d?: number;
  disputesOpenedLast90d?: number;
  disputesAsPartyTotal?: number;
  failedLoginsLast15m?: number;
  identityVerified?: boolean;
  businessVerified?: boolean;
  userCountry?: string;
  originCountry?: string;
  destinationCountry?: string;
  corridorSupported?: boolean;
  documentSha256DuplicateCount?: number;
  counterpartyEmailSeenInDisputes?: number;
  accountAgeDays?: number;
  /** Transfers (Diaspora Transfer) */
  transfersLast24h?: number;
  transfersAmountLast24hMinor?: bigint;
  beneficiaryAgeHours?: number;
  beneficiaryChangesLast24h?: number;
  walletBalanceMinor?: bigint;
  /** Reference of the operation behind the event (ledger transaction id, transfer reference…). */
  operationReference?: string;
  /** Structuring detection: operations of the subject(s) in the rolling window (see STRUCTURING). */
  structuring?: StructuringFacts;
}

export type RiskEvent = RiskFacts['event'];

export interface RiskEvaluation {
  totalScore: number;
  highestSeverity: RiskSeverity | null;
  signals: RiskSignal[];
  /** Human readable, for compliance queues. Never an automatic refusal. */
  recommendation: 'NONE' | 'MONITOR' | 'MANUAL_REVIEW';
}

export interface RiskRule {
  code: string;
  description: string;
  appliesTo: RiskFacts['event'][];
  evaluate(facts: RiskFacts): RiskSignal | null;
}
