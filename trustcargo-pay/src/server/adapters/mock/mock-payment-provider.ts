/**
 * MockPaymentProvider — SIMULATION ONLY. No real money is held or transferred.
 *
 * Simulates the partner side of the integration: it keeps its own records, answers API calls and
 * emits SIGNED webhook events that go through exactly the same verification pipeline as a real
 * partner's events. The simulator controls (demo UI, tests) drive it via `simulate*` methods.
 *
 * Its records (instructions, transfers, statement) live in a SimulatedPartnerStore: in memory by default,
 * in schema `trustcargo_sim` with Postgres persistence, so they survive restarts and are shared by every
 * instance. Store writes are committed before the corresponding webhook is emitted, except during
 * `withStagedWrites` (first-boot demo seed), which publishes them only once the seed has succeeded. The
 * simulated outage counter (`simulateOutage`) stays in process memory: with several instances, only the
 * instance that received the request fails its next partner calls.
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
import {
    MemorySimulatedPartnerStore,
    StagedSimulatedPartnerStore,
    type SimulatedPartnerStore,
    type TransferKind
} from './simulated-partner-store';

type Delivery = (rawBody: string, signatureHeader: string) => Promise<unknown>;

export class MockPaymentProvider implements PaymentProvider {
    readonly name = 'mock';
    readonly simulated = true;
    private deliver: Delivery | undefined;
    /** Number of upcoming API calls that will fail with a (retryable) partner error. Per process (not persisted). */
    private pendingFailures = 0;

    constructor(
        private readonly webhookSecret: string,
        private readonly clock: Clock,
        private store: SimulatedPartnerStore = new MemorySimulatedPartnerStore()
    ) {}

    /**
     * Runs `fn` with this partner's writes held back (StagedSimulatedPartnerStore), then publishes them in order
     * once `fn` has succeeded; if it fails they are discarded. The first-boot demo seed runs this way, so a seed
     * that rolls back leaves no partner records behind. Every partner call of this instance is staged meanwhile:
     * only for a run that has the instance to itself (the seed, before the instance serves requests).
     */
    async withStagedWrites<T>(fn: () => Promise<T>): Promise<T> {
        const base = this.store;
        const staged = new StagedSimulatedPartnerStore(base);
        this.store = staged;
        try {
            const result = await fn();
            this.store = base;
            await staged.publish();
            return result;
        } finally {
            this.store = base;
        }
    }

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
        // Idempotent: a known key returns the instruction already issued for it.
        const { reference } = await this.store.createInstruction({
            reference: `sim_pi_${randomToken(9)}`,
            idempotencyKey: request.idempotencyKey,
            amount: request.amount,
            status: 'CREATED'
        });
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
        return (await this.store.getInstruction(providerReference))?.status ?? 'EXPIRED';
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

    /** Idempotent: a known key returns the transfer already accepted for it (reported as SUBMITTED, as before). */
    private async submitTransfer(kind: TransferKind, amount: Money, idempotencyKey: string): Promise<ProviderSubmission> {
        const { reference } = await this.store.createTransfer({
            reference: `sim_${kind === 'PAYOUT' ? 'po' : 'rf'}_${randomToken(9)}`,
            kind,
            idempotencyKey,
            amount,
            status: 'SUBMITTED'
        });
        return { providerReference: reference, status: 'SUBMITTED' };
    }

    async getPayoutStatus(providerReference: string): Promise<ProviderPayoutStatus> {
        const t = await this.store.getTransfer(providerReference);
        if (!t) throw new ProviderError('Unknown payout reference', false);
        return t.status;
    }

    async reconcileTransactions(range: { from: string; to: string }): Promise<StatementLine[]> {
        return this.store.statement(range);
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
        const instruction = await this.store.getInstruction(instructionReference);
        if (!instruction) throw new ProviderError('Unknown instruction', false);
        const amount = options.amountMinor ?? instruction.amount.amountMinor;
        const base = { instructionReference, currency: instruction.amount.currency };
        await this.emit('payment.initiated', base);
        await this.store.setInstructionStatus(instructionReference, 'PENDING');
        if (options.stopAt === 'initiated') return;
        await this.emit('payment.pending', base);
        if (options.stopAt === 'pending') return;
        await this.store.setInstructionStatus(instructionReference, 'FUNDED', {
            externalReference: instructionReference,
            kind: 'FUNDS_RECEIVED',
            amountMinor: amount.toString(),
            currency: base.currency,
            occurredAt: this.clock.now().toISOString()
        });
        await this.emit('funds.confirmed', { ...base, amountMinor: amount.toString() });
    }

    async simulateFundingFailure(instructionReference: string, reason = 'Virement rejeté par la banque émettrice (simulation)') {
        await this.store.setInstructionStatus(instructionReference, 'FAILED'); // unknown reference → ProviderError
        await this.emit('payment.failed', { instructionReference, reason });
    }

    async simulateTransferOutcome(providerReference: string, outcome: 'PAID' | 'FAILED', reason?: string) {
        const t = await this.store.getTransfer(providerReference);
        if (!t) throw new ProviderError('Unknown transfer', false);
        const key = t.kind === 'PAYOUT' ? 'payoutReference' : 'refundReference';
        await this.store.setTransferStatus(
            providerReference,
            outcome,
            outcome === 'PAID'
                ? {
                      externalReference: providerReference,
                      kind: t.kind === 'PAYOUT' ? 'PAYOUT_PAID' : 'REFUND_PAID',
                      amountMinor: t.amount.amountMinor.toString(),
                      currency: t.amount.currency,
                      occurredAt: this.clock.now().toISOString()
                  }
                : undefined
        );
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
    async injectStatementDiscrepancy(line: StatementLine): Promise<void> {
        await this.store.appendStatementLine(line);
    }

    /** Every transfer known to the partner, in creation order (filter on `status` for the pending ones). */
    async pendingTransfers(): Promise<{ reference: string; kind: TransferKind; status: ProviderPayoutStatus }[]> {
        return (await this.store.listTransfers()).map((t) => ({ reference: t.reference, kind: t.kind, status: t.status }));
    }
}
