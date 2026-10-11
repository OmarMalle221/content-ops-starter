import { randomBytes } from 'node:crypto';
import type {
  ExecutionResult,
  FundingInstructions,
  FundingInstructionsRequest,
  PartnerEvent,
  PaymentProviderAdapter,
  RefundRequest,
  ReleaseRequest,
} from './types';

export const SANDBOX_PROVIDER_CODE = 'SANDBOX_PARTNER';

/**
 * Simulated licensed partner. It produces fictitious funding instructions and
 * acknowledges releases/refunds instantly. No external call is ever made.
 */
export class SandboxPaymentProvider implements PaymentProviderAdapter {
  readonly code = SANDBOX_PROVIDER_CODE;
  readonly mode = 'SANDBOX' as const;

  constructor(private readonly options: { fundingTtlHours?: number } = {}) {}

  async createFundingInstructions(req: FundingInstructionsRequest): Promise<FundingInstructions> {
    const reference = `SBXF-${req.transactionReference}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const ttl = (this.options.fundingTtlHours ?? 72) * 3600 * 1000;
    return {
      providerCode: this.code,
      mode: this.mode,
      reference,
      expiresAt: new Date(Date.now() + ttl),
      instructions: {
        type: req.method,
        beneficiaryName: 'Diaspora Trust — SANDBOX settlement account (fictitious)',
        beneficiaryAccount: 'CA00 SBOX 0000 0000 0000 00',
        paymentReference: reference,
        notice: 'Données fictives — Aucun fonds réel / Simulated data — no real funds. Do not send money.',
      },
    };
  }

  async simulateFundingEvent(input: {
    fundingReference: string;
    outcome: 'CONFIRMED' | 'FAILED';
    externalRef?: string;
  }): Promise<PartnerEvent> {
    const externalRef = input.externalRef ?? `sbx_evt_${randomBytes(6).toString('hex')}`;
    return {
      providerCode: this.code,
      type: input.outcome === 'CONFIRMED' ? 'funding.confirmed' : 'funding.failed',
      idempotencyKey: `${this.code}:${input.fundingReference}:${input.outcome}`,
      externalRef,
      occurredAt: new Date(),
      payload: { fundingReference: input.fundingReference, outcome: input.outcome, simulated: true },
    };
  }

  async executeRelease(req: ReleaseRequest): Promise<ExecutionResult> {
    return {
      providerCode: this.code,
      mode: this.mode,
      externalRef: `sbx_rel_${req.milestoneId.slice(0, 8)}_${randomBytes(3).toString('hex')}`,
      status: 'EXECUTED_SIMULATED',
      executedAt: new Date(),
    };
  }

  async executeRefund(req: RefundRequest): Promise<ExecutionResult> {
    return {
      providerCode: this.code,
      mode: this.mode,
      externalRef: `sbx_ref_${req.transactionId.slice(0, 8)}_${randomBytes(3).toString('hex')}`,
      status: 'EXECUTED_SIMULATED',
      executedAt: new Date(),
    };
  }
}
