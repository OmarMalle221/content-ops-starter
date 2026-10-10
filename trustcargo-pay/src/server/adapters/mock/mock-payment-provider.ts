/**
 * MockPaymentProvider — SIMULATION ONLY. No real money is held or transferred.
 *
 * Simulates the partner side of the integration: it keeps its own records, answers API calls and
 * emits SIGNED webhook events that go through exactly the same verification pipeline as a real
 * partner's events. The simulator controls (demo UI, tests) drive it via `simulate*` methods.
 */
import type { Money } from '@/domain/money';
import { randomToken } from '@/server/security/crypto';
import { signPayload, verifySignature } from '@/server/security/webhook-signature';
import type { ProviderEventType } from '@/domain/model';
import {
    ProviderError,
    type FundingStatus,
    type PaymentInstructionRequest,
    type PaymentInstructionResult,
    type PaymentProvider,
    type ProviderPayoutStatus,
    type ProviderSubmission,
    type RefundRequest,
    type ReleaseRequest,
    type StatementLine,
    type VerifiedProviderEvent
} from '@/server/ports/payment-provider';
import type { Clock } from '@/server/ports/providers';

type Delivery = (rawBody: string, signatureHeader: string) => Promise<unknown>;

interface PartnerInstruction {
    reference: string;
    request: PaymentInstructionRequest;
    status: FundingStatus;
}
interface PartnerTransfer {
    reference: string;
    kind: 'PAYOUT' | 'REFUND';
    amount: Money;
    status: ProviderPayoutStatus;
    idempotencyKey: string;
}

export class MockPaymentProvider implements PaymentProvider {
    readonly name = 'mock';
    readonly simulated = true;
    private readonly instructions = new Map<string, PartnerInstruction>();
    private readonly instructionsByKey = new Map<string, string>();
    private readonly transfers = new Map<string, PartnerTransfer>();
    private readonly transfersByKey = new Map<string, string>();
    private readonly statement: StatementLine[] = [];
    private deliver: Delivery | undefined;
    /** Number of upcoming API calls that will fail with a (retryable) partner error. */
    private pendingFailures = 0;

    constructor(
        private readonly webhookSecret: string,
        private readonly clock: Clock
    ) {}

    setDelivery(deliver: Delivery): void {
        this.deliver = deliver;
    }

    /** Simulates partner downtime for the next `count` API calls. */
    simulateOutage(count = 1): void {
        this.pendingFailures = count;
    }

    private maybeFail(operation: string) {
        if (this.pendingFailures > 0) {
            this.pendingFailures -= 1;
            throw new ProviderError(`Simulated partner error during ${operation}`, true);
        }
    }

    async createPaymentInstruction(request: PaymentInstructionRequest): Promise<PaymentInstructionResult> {
        this.maybeFail('createPaymentInstruction');
        const existing = this.instructionsByKey.get(request.idempotencyKey);
        const reference = existing ?? `sim_pi_${randomToken(9)}`;
        if (!existing) {
            this.instructions.set(reference, { reference, request, status: 'CREATED' });
            this.instructionsByKey.set(request.idempotencyKey, reference);
        }
        return {
            providerReference: reference,
            expiresAt: new Date(this.clock.now().getTime() + 14 * 86_400_000).toISOString(),
            details: {
                method: 'BANK_TRANSFER',
                beneficiaryName: 'Partenaire financier simulé (SIMULATION)',
                bankName: 'Banque de simulation — aucun compte réel',
                accountMasked: 'SIM •••• 0000',
                paymentReference: request.transactionReference,
                notes: 'SIMULATION : n’envoyez aucun argent. Ces coordonnées sont fictives.'
            }
        };
    }

    async getFundingStatus(providerReference: string): Promise<FundingStatus> {
        return this.instructions.get(providerReference)?.status ?? 'EXPIRED';
    }

    async confirmProviderEvent(rawBody: string, signatureHeader: string | null) {
        const verification = verifySignature(this.webhookSecret, rawBody, signatureHeader, Math.floor(this.clock.now().getTime() / 1000));
        if (!verification.ok) return { ok: false as const, reason: verification.reason };
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
            return { ok: false as const, reason: 'INVALID_JSON' };
        }
        const data = (parsed.data ?? {}) as VerifiedProviderEvent['data'];
        if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string' || typeof parsed.created !== 'string') {
            return { ok: false as const, reason: 'INVALID_SHAPE' };
        }
        return {
            ok: true as const,
            event: { externalEventId: parsed.id, type: parsed.type as ProviderEventType, occurredAt: parsed.created, data, raw: parsed }
        };
    }

    async requestAuthorizedRelease(request: ReleaseRequest): Promise<ProviderSubmission> {
        this.maybeFail('requestAuthorizedRelease');
        return this.submitTransfer('PAYOUT', request.amount, request.idempotencyKey);
    }

    async requestAuthorizedRefund(request: RefundRequest): Promise<ProviderSubmission> {
        this.maybeFail('requestAuthorizedRefund');
        return this.submitTransfer('REFUND', request.amount, request.idempotencyKey);
    }

    private submitTransfer(kind: 'PAYOUT' | 'REFUND', amount: Money, idempotencyKey: string): ProviderSubmission {
        const existing = this.transfersByKey.get(idempotencyKey);
        if (existing) return { providerReference: existing, status: 'SUBMITTED' };
        const reference = `sim_${kind === 'PAYOUT' ? 'po' : 'rf'}_${randomToken(9)}`;
        this.transfers.set(reference, { reference, kind, amount, status: 'SUBMITTED', idempotencyKey });
        this.transfersByKey.set(idempotencyKey, reference);
        return { providerReference: reference, status: 'SUBMITTED' };
    }

    async getPayoutStatus(providerReference: string): Promise<ProviderPayoutStatus> {
        const t = this.transfers.get(providerReference);
        if (!t) throw new ProviderError('Unknown payout reference', false);
        return t.status;
    }

    async reconcileTransactions(range: { from: string; to: string }): Promise<StatementLine[]> {
        return this.statement.filter((l) => l.occurredAt >= range.from && l.occurredAt <= range.to).map((l) => ({ ...l }));
    }

    /* ------------------------------------------------------------------ simulator controls */

    private async emit(type: ProviderEventType, data: VerifiedProviderEvent['data']) {
        if (!this.deliver) throw new Error('Mock provider delivery not configured');
        const body = JSON.stringify({
            id: `sim_evt_${randomToken(12)}`,
            type,
            created: this.clock.now().toISOString(),
            livemode: false,
            data
        });
        const header = signPayload(this.webhookSecret, body, Math.floor(this.clock.now().getTime() / 1000));
        return this.deliver(body, header);
    }

    /** Buyer "sends" funds: initiated → pending → confirmed. `amountMinor` lets tests simulate a wrong amount. */
    async simulateFunding(instructionReference: string, options: { amountMinor?: bigint; stopAt?: 'initiated' | 'pending' } = {}) {
        const instruction = this.instructions.get(instructionReference);
        if (!instruction) throw new ProviderError('Unknown instruction', false);
        const amount = options.amountMinor ?? instruction.request.amount.amountMinor;
        const base = { instructionReference, currency: instruction.request.amount.currency };
        await this.emit('payment.initiated', base);
        instruction.status = 'PENDING';
        if (options.stopAt === 'initiated') return;
        await this.emit('payment.pending', base);
        if (options.stopAt === 'pending') return;
        instruction.status = 'FUNDED';
        this.statement.push({
            externalReference: instructionReference,
            kind: 'FUNDS_RECEIVED',
            amountMinor: amount.toString(),
            currency: base.currency,
            occurredAt: this.clock.now().toISOString()
        });
        await this.emit('funds.confirmed', { ...base, amountMinor: amount.toString() });
    }

    async simulateFundingFailure(instructionReference: string, reason = 'Virement rejeté par la banque émettrice (simulation)') {
        const instruction = this.instructions.get(instructionReference);
        if (!instruction) throw new ProviderError('Unknown instruction', false);
        instruction.status = 'FAILED';
        await this.emit('payment.failed', { instructionReference, reason });
    }

    async simulateTransferOutcome(providerReference: string, outcome: 'PAID' | 'FAILED', reason?: string) {
        const t = this.transfers.get(providerReference);
        if (!t) throw new ProviderError('Unknown transfer', false);
        t.status = outcome;
        const key = t.kind === 'PAYOUT' ? 'payoutReference' : 'refundReference';
        if (outcome === 'PAID') {
            this.statement.push({
                externalReference: providerReference,
                kind: t.kind === 'PAYOUT' ? 'PAYOUT_PAID' : 'REFUND_PAID',
                amountMinor: t.amount.amountMinor.toString(),
                currency: t.amount.currency,
                occurredAt: this.clock.now().toISOString()
            });
        }
        const type: ProviderEventType =
            t.kind === 'PAYOUT'
                ? outcome === 'PAID'
                    ? 'payout.paid'
                    : 'payout.failed'
                : outcome === 'PAID'
                  ? 'refund.completed'
                  : 'refund.failed';
        await this.emit(type, {
            [key]: providerReference,
            amountMinor: t.amount.amountMinor.toString(),
            currency: t.amount.currency,
            reason
        });
    }

    /** Re-sends an exact copy of a previous webhook (tests replay protection). */
    async replay(rawBody: string) {
        if (!this.deliver) throw new Error('Mock provider delivery not configured');
        return this.deliver(rawBody, signPayload(this.webhookSecret, rawBody, Math.floor(this.clock.now().getTime() / 1000)));
    }

    /** Adds a statement line with no ledger counterpart — used to demonstrate reconciliation exceptions. */
    injectStatementDiscrepancy(line: StatementLine) {
        this.statement.push(line);
    }

    pendingTransfers(): { reference: string; kind: 'PAYOUT' | 'REFUND'; status: ProviderPayoutStatus }[] {
        return [...this.transfers.values()].map((t) => ({ reference: t.reference, kind: t.kind, status: t.status }));
    }
}
