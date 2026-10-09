/**
 * PaymentProvider — abstraction over a legally authorised financial partner (licensed trust /
 * escrow / payment institution). TrustCargo never holds funds itself: it only sends instructions
 * the partner is contractually and legally allowed to execute, and records the partner's reports.
 */
import type { Money } from '@/domain/money';
import type { ProviderEventType } from '@/domain/model';

export interface PaymentInstructionRequest {
    transactionId: string;
    transactionReference: string;
    amount: Money;
    payerName: string;
    idempotencyKey: string;
}

export interface PaymentInstructionResult {
    providerReference: string;
    expiresAt: string;
    details: {
        method: 'BANK_TRANSFER';
        beneficiaryName: string;
        bankName: string;
        accountMasked: string;
        paymentReference: string;
        notes: string;
    };
}

export interface ReleaseRequest {
    payoutId: string;
    transactionId: string;
    amount: Money;
    payeeAccountToken: string;
    idempotencyKey: string;
    /** Reference of the authorising decision (milestone approval or dispute decision). */
    authorizationReference: string;
}

export interface RefundRequest {
    refundId: string;
    transactionId: string;
    fundingReference: string;
    amount: Money;
    idempotencyKey: string;
    authorizationReference: string;
}

export interface ProviderSubmission {
    providerReference: string;
    status: 'SUBMITTED' | 'PROCESSING';
}

/** Normalised, authenticated partner event. */
export interface VerifiedProviderEvent {
    externalEventId: string;
    type: ProviderEventType;
    occurredAt: string;
    data: {
        instructionReference?: string;
        payoutReference?: string;
        refundReference?: string;
        amountMinor?: string;
        currency?: string;
        reason?: string;
    };
    raw: Record<string, unknown>;
}

export interface StatementLine {
    externalReference: string;
    kind: 'FUNDS_RECEIVED' | 'PAYOUT_PAID' | 'REFUND_PAID';
    amountMinor: string;
    currency: string;
    occurredAt: string;
}

export type FundingStatus = 'CREATED' | 'PENDING' | 'FUNDED' | 'FAILED' | 'EXPIRED';
export type ProviderPayoutStatus = 'SUBMITTED' | 'PROCESSING' | 'PAID' | 'FAILED';

export class ProviderError extends Error {
    constructor(
        message: string,
        public readonly retryable: boolean
    ) {
        super(message);
        this.name = 'ProviderError';
    }
}

export interface PaymentProvider {
    readonly name: string;
    /** True when no real money can move through this provider. Drives the UI disclaimer. */
    readonly simulated: boolean;
    createPaymentInstruction(request: PaymentInstructionRequest): Promise<PaymentInstructionResult>;
    getFundingStatus(providerReference: string): Promise<FundingStatus>;
    /** Authenticates and parses a webhook. Returns null when the signature is invalid. */
    confirmProviderEvent(
        rawBody: string,
        signatureHeader: string | null
    ): Promise<{ ok: true; event: VerifiedProviderEvent } | { ok: false; reason: string }>;
    requestAuthorizedRelease(request: ReleaseRequest): Promise<ProviderSubmission>;
    requestAuthorizedRefund(request: RefundRequest): Promise<ProviderSubmission>;
    getPayoutStatus(providerReference: string): Promise<ProviderPayoutStatus>;
    reconcileTransactions(range: { from: string; to: string }): Promise<StatementLine[]>;
}
