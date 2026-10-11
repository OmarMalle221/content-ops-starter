/**
 * Payment partner adapter contract.
 *
 * Real funds are always held and moved by a licensed partner (bank, payment institution,
 * money services business). The platform only issues instructions and records partner
 * events. The sandbox adapter below simulates such a partner and NEVER moves money.
 */
export type ProviderMode = 'SANDBOX' | 'LIVE';

export interface FundingInstructionsRequest {
  transactionId: string;
  transactionReference: string;
  amountMinor: bigint;
  currencyCode: string;
  payerName: string;
  method: 'BANK_TRANSFER_SIMULATED' | 'WALLET_SIMULATED';
}

export interface FundingInstructions {
  providerCode: string;
  mode: ProviderMode;
  reference: string;
  expiresAt: Date;
  /** Displayed to the payer. Sandbox instructions are clearly marked fictitious. */
  instructions: {
    type: string;
    beneficiaryName: string;
    beneficiaryAccount: string;
    paymentReference: string;
    notice: string;
  };
}

export interface PartnerEvent {
  providerCode: string;
  type: 'funding.confirmed' | 'funding.failed' | 'release.executed' | 'refund.executed';
  idempotencyKey: string;
  externalRef: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export interface ReleaseRequest {
  transactionId: string;
  milestoneId: string;
  amountMinor: bigint;
  currencyCode: string;
  beneficiaryOrganizationId: string;
}

export interface RefundRequest {
  transactionId: string;
  amountMinor: bigint;
  currencyCode: string;
  beneficiaryOrganizationId: string;
  reason: string;
}

export interface ExecutionResult {
  providerCode: string;
  mode: ProviderMode;
  externalRef: string;
  status: 'EXECUTED_SIMULATED';
  executedAt: Date;
}

export interface PaymentProviderAdapter {
  readonly code: string;
  readonly mode: ProviderMode;
  createFundingInstructions(req: FundingInstructionsRequest): Promise<FundingInstructions>;
  /** Simulated partner callback. Only meaningful for the sandbox adapter. */
  simulateFundingEvent(input: {
    fundingReference: string;
    outcome: 'CONFIRMED' | 'FAILED';
    externalRef?: string;
  }): Promise<PartnerEvent>;
  executeRelease(req: ReleaseRequest): Promise<ExecutionResult>;
  executeRefund(req: RefundRequest): Promise<ExecutionResult>;
}
