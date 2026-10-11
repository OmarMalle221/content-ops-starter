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
  };
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
    | 'document.uploaded';
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
}

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
