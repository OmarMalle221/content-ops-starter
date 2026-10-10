/**
 * Ingestion of partner webhooks — the ONLY path through which money-related state changes.
 *
 * 1. Authenticate (HMAC signature + timestamp tolerance) → reject otherwise.
 * 2. De-duplicate on (provider, external_event_id) → replays of a handled event are acknowledged but not
 *    re-applied. A stored event whose processing never completed is processed again on redelivery: FAILED,
 *    or still RECEIVED after a grace period (crash, lost connection or busy database between the two units
 *    of work). Within the grace period a redelivery is answered UNAVAILABLE (503): the partner retries later.
 * 3. Persist the raw event (RECEIVED), then process it in a separate unit of work, which re-reads the event
 *    first and skips it when another delivery or a reprocess has handled it meanwhile (idempotent).
 * 4. Processing failures mark the event FAILED for manual review / reprocessing; nothing partial is kept.
 */
import { journalTemplates } from '@/domain/ledger/ledger';
import type { ProviderEvent, Transaction } from '@/domain/model';
import type { Db } from '@/server/ports/db';
import type { VerifiedProviderEvent } from '@/server/ports/payment-provider';
import type { Actor, SystemActor } from '@/server/auth/actor';
import { SYSTEM, hasRole } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { truncateText } from '@/server/text';
import { buildReversal } from '@/domain/ledger/ledger';
import { audit, notifyRole, type Deps } from './context';
import type { LedgerService } from './ledger-service';
import type { PaymentService } from './payment-service';
import type { Workflow } from './workflow';
import { currentMilestones } from './workflow';

/** A RECEIVED event younger than this may still be in its first processing (another request or instance). */
export const RECEIVED_GRACE_MS = 60_000;

/** Statuses of an event that has not been handled yet. */
const UNHANDLED: ReadonlySet<ProviderEvent['status']> = new Set(['RECEIVED', 'FAILED']);

export class ProviderEventService {
    /** Hook used by disputes to close themselves once settlement completes. */
    onSettlementProgress?: (db: Db, transactionId: string) => Promise<void>;

    constructor(
        private readonly deps: Deps,
        private readonly workflow: Workflow,
        private readonly ledger: LedgerService,
        private readonly payments: PaymentService
    ) {}

    private get providerActor(): SystemActor {
        return { kind: 'PROVIDER', id: this.deps.payments.name };
    }

    async ingest(
        rawBody: string,
        signatureHeader: string | null
    ): Promise<{ status: 'processed' | 'duplicate' | 'failed'; eventId: string }> {
        const verification = await this.deps.payments.confirmProviderEvent(rawBody, signatureHeader);
        if (!verification.ok) {
            await this.deps.uow.run((db) =>
                audit(
                    this.deps,
                    db,
                    this.providerActor,
                    'provider_event.rejected',
                    { type: 'provider_event', id: 'unverified' },
                    { metadata: { reason: verification.reason } }
                )
            );
            throw new AppError('INVALID_SIGNATURE', 'Webhook authentication failed');
        }
        const event = verification.event;
        const stored = await this.deps.uow.run(async (db) => {
            const existing = await db.providerEvents.findOne({ provider: this.deps.payments.name, externalEventId: event.externalEventId });
            if (existing) {
                if (!this.reprocessable(existing))
                    return {
                        record: existing,
                        outcome: existing.status === 'RECEIVED' ? ('in_progress' as const) : ('duplicate' as const)
                    };
                await audit(
                    this.deps,
                    db,
                    this.providerActor,
                    'provider_event.redelivered',
                    { type: 'provider_event', id: existing.id },
                    { metadata: { status: existing.status } }
                );
                return { record: existing, outcome: 'retry' as const };
            }
            const record: ProviderEvent = {
                id: this.deps.ids.id(),
                provider: this.deps.payments.name,
                externalEventId: event.externalEventId,
                type: event.type,
                payload: event.raw,
                signatureVerified: true,
                status: 'RECEIVED',
                occurredAt: event.occurredAt,
                receivedAt: this.deps.clock.now().toISOString()
            };
            await db.providerEvents.insert(record);
            return { record, outcome: 'new' as const };
        });
        switch (stored.outcome) {
            case 'duplicate':
                return { status: 'duplicate', eventId: stored.record.id };
            case 'in_progress':
                throw new AppError('UNAVAILABLE', 'This event is still being processed. Please retry later.', { retryable: true });
            case 'retry':
                return this.process(stored.record.id, this.storedEvent(stored.record));
            default:
                return this.process(stored.record.id, event);
        }
    }

    /**
     * Whether the event still has to be applied: FAILED, or RECEIVED for longer than the grace period (its
     * processing never completed). Redeliveries and the finance "Reprocess" action use the same rule.
     */
    reprocessable(event: Pick<ProviderEvent, 'status' | 'receivedAt'>): boolean {
        if (event.status === 'FAILED') return true;
        return event.status === 'RECEIVED' && this.deps.clock.now().getTime() - Date.parse(event.receivedAt) >= RECEIVED_GRACE_MS;
    }

    /** Manual recovery (finance operators) of FAILED events and of events left RECEIVED past the grace period. */
    async reprocess(actor: Actor, eventId: string) {
        if (!hasRole(actor, 'finance_operator')) throw forbidden();
        const record = await this.deps.uow.run(async (db) => {
            const found = await db.providerEvents.get(eventId);
            if (!found) throw notFound('Event');
            if (!this.reprocessable(found))
                throw new AppError('CONFLICT', 'Only failed events, or events left unprocessed for over a minute, can be reprocessed');
            await audit(
                this.deps,
                db,
                actor,
                'provider_event.reprocess_requested',
                { type: 'provider_event', id: eventId },
                { metadata: { status: found.status } }
            );
            return found;
        });
        return this.process(eventId, this.storedEvent(record));
    }

    /** The verified event as recorded at ingestion (the stored payload is immutable). */
    private storedEvent(record: ProviderEvent): VerifiedProviderEvent {
        const raw = record.payload as { data?: VerifiedProviderEvent['data'] };
        return {
            externalEventId: record.externalEventId,
            type: record.type,
            occurredAt: record.occurredAt,
            data: raw.data ?? {},
            raw: record.payload
        };
    }

    private async process(eventId: string, event: VerifiedProviderEvent) {
        let applied: { transactionId?: string } | undefined;
        try {
            applied = await this.deps.uow.run(async (db) => {
                // Re-read under the unit of work: a concurrent delivery or reprocess may have handled it already.
                const current = await db.providerEvents.get(eventId);
                if (!current || !UNHANDLED.has(current.status)) return undefined;
                const outcome = await this.apply(db, eventId, event);
                await db.providerEvents.update(eventId, {
                    status: outcome.ignored ? 'IGNORED' : outcome.error ? 'FAILED' : 'PROCESSED',
                    error: outcome.error,
                    transactionId: outcome.transactionId,
                    processedAt: this.deps.clock.now().toISOString()
                });
                return { transactionId: outcome.transactionId };
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            const marked = await this.deps.uow.run(async (db) => {
                // Never overwrite the outcome of a concurrent processing that succeeded meanwhile.
                const current = await db.providerEvents.get(eventId);
                if (!current || !UNHANDLED.has(current.status)) return false;
                await db.providerEvents.update(eventId, {
                    status: 'FAILED',
                    error: truncateText(message, 500),
                    processedAt: this.deps.clock.now().toISOString()
                });
                await audit(
                    this.deps,
                    db,
                    SYSTEM,
                    'provider_event.processing_failed',
                    { type: 'provider_event', id: eventId },
                    { metadata: { type: event.type, error: truncateText(message, 200) } }
                );
                await notifyRole(this.deps, db, 'finance_operator', 'provider_event.failed', { type: event.type });
                return true;
            });
            return { status: marked ? ('failed' as const) : ('duplicate' as const), eventId };
        }
        if (!applied) return { status: 'duplicate' as const, eventId };
        if (applied.transactionId) await this.payments.dispatchPending(applied.transactionId);
        const final = await this.deps.uow.run((db) => db.providerEvents.get(eventId));
        return { status: final?.status === 'FAILED' ? ('failed' as const) : ('processed' as const), eventId };
    }

    private async apply(
        db: Db,
        eventId: string,
        event: VerifiedProviderEvent
    ): Promise<{ transactionId?: string; ignored?: boolean; error?: string }> {
        const d = event.data;
        switch (event.type) {
            case 'payment.initiated':
            case 'payment.pending':
            case 'funds.confirmed':
            case 'payment.failed': {
                const instruction = await db.paymentInstructions.findOne({ providerReference: d.instructionReference ?? '' });
                if (!instruction) throw new Error('Unknown payment instruction reference');
                const tx = (await db.transactions.get(instruction.transactionId))!;
                if (instruction.status === 'CANCELLED') {
                    await audit(
                        this.deps,
                        db,
                        this.providerActor,
                        'provider_event.funds_on_cancelled_instruction',
                        { type: 'payment_instruction', id: instruction.id },
                        { transactionId: tx.id, metadata: { type: event.type } }
                    );
                    await notifyRole(this.deps, db, 'finance_operator', 'provider_event.needs_review', { reference: tx.reference }, tx.id);
                    return { transactionId: tx.id, error: 'EVENT_ON_CANCELLED_INSTRUCTION' };
                }
                if (event.type === 'funds.confirmed') return this.onFundsConfirmed(db, eventId, event, tx, instruction.id);
                if (event.type === 'payment.failed') {
                    await db.paymentInstructions.update(instruction.id, {
                        status: 'FAILED',
                        failureReason: typeof d.reason === 'string' ? truncateText(d.reason, 300) : undefined,
                        updatedAt: this.deps.clock.now().toISOString()
                    });
                    if (tx.status === 'FUNDING_PENDING')
                        await this.workflow.transition(db, tx, 'FUNDING_FAILED', 'PROVIDER', this.providerActor, { metadata: { eventId } });
                    await this.payments.notifyParties(db, tx, 'payment.failed');
                    return { transactionId: tx.id };
                }
                if (instruction.status === 'CREATED')
                    await db.paymentInstructions.update(instruction.id, {
                        status: 'PENDING',
                        updatedAt: this.deps.clock.now().toISOString()
                    });
                if (tx.status === 'AWAITING_FUNDING') {
                    await this.workflow.transition(db, tx, 'FUNDING_INITIATED', 'PROVIDER', this.providerActor, { metadata: { eventId } });
                    return { transactionId: tx.id };
                }
                return { transactionId: tx.id, ignored: true };
            }
            case 'payout.authorized':
            case 'payout.paid':
            case 'payout.failed': {
                const payout = await db.payouts.findOne({ providerReference: d.payoutReference ?? '' });
                if (!payout) throw new Error('Unknown payout reference');
                const tx = (await db.transactions.get(payout.transactionId))!;
                const now = this.deps.clock.now().toISOString();
                if (event.type === 'payout.authorized') {
                    if (payout.status === 'SUBMITTED') await db.payouts.update(payout.id, { status: 'PROCESSING', updatedAt: now });
                    return { transactionId: tx.id };
                }
                if (payout.status === 'PAID' || payout.status === 'FAILED' || payout.status === 'CANCELLED')
                    return { transactionId: tx.id, ignored: true };
                if (d.amountMinor !== undefined && BigInt(d.amountMinor) !== payout.amount.amountMinor) {
                    await notifyRole(this.deps, db, 'finance_operator', 'provider_event.needs_review', { reference: tx.reference }, tx.id);
                    return { transactionId: tx.id, error: 'PAYOUT_AMOUNT_MISMATCH' };
                }
                if (event.type === 'payout.paid') {
                    await db.payouts.update(payout.id, { status: 'PAID', updatedAt: now });
                    await this.ledger.post(
                        db,
                        journalTemplates.payoutSettled({
                            provider: payout.provider,
                            transactionId: tx.id,
                            currency: payout.amount.currency,
                            amountMinor: payout.amount.amountMinor,
                            externalReference: payout.providerReference!,
                            providerEventId: eventId,
                            payoutId: payout.id
                        }),
                        this.providerActor
                    );
                    await this.markMilestonesReleased(db, tx, payout.milestoneId, payout.disputeDecisionId);
                    await audit(
                        this.deps,
                        db,
                        this.providerActor,
                        'payout.paid',
                        { type: 'payout', id: payout.id },
                        { transactionId: tx.id, metadata: { eventId } }
                    );
                    await this.payments.notifyParties(db, tx, 'payout.paid');
                } else {
                    await db.payouts.update(payout.id, {
                        status: 'FAILED',
                        failureReason: typeof d.reason === 'string' ? truncateText(d.reason, 300) : 'Reported failed by partner',
                        updatedAt: now
                    });
                    await this.reverseAuthorization(db, `release:${payout.id}`, 'payout failed at partner');
                    await audit(
                        this.deps,
                        db,
                        this.providerActor,
                        'payout.failed',
                        { type: 'payout', id: payout.id },
                        { transactionId: tx.id, metadata: { eventId } }
                    );
                    await notifyRole(this.deps, db, 'finance_operator', 'payout.failed', { reference: tx.reference }, tx.id);
                }
                await this.workflow.autoAdvance(db, tx.id);
                await this.onSettlementProgress?.(db, tx.id);
                return { transactionId: tx.id };
            }
            case 'refund.processing':
            case 'refund.completed':
            case 'refund.failed': {
                const refund = await db.refunds.findOne({ providerReference: d.refundReference ?? '' });
                if (!refund) throw new Error('Unknown refund reference');
                const tx = (await db.transactions.get(refund.transactionId))!;
                const now = this.deps.clock.now().toISOString();
                if (event.type === 'refund.processing') {
                    if (refund.status === 'SUBMITTED') await db.refunds.update(refund.id, { status: 'PROCESSING', updatedAt: now });
                    return { transactionId: tx.id };
                }
                if (refund.status === 'REFUNDED' || refund.status === 'FAILED' || refund.status === 'CANCELLED')
                    return { transactionId: tx.id, ignored: true };
                if (event.type === 'refund.completed') {
                    await db.refunds.update(refund.id, { status: 'REFUNDED', updatedAt: now });
                    await this.ledger.post(
                        db,
                        journalTemplates.refundSettled({
                            provider: refund.provider,
                            transactionId: tx.id,
                            currency: refund.amount.currency,
                            amountMinor: refund.amount.amountMinor,
                            externalReference: refund.providerReference!,
                            providerEventId: eventId,
                            refundId: refund.id
                        }),
                        this.providerActor
                    );
                    for (const m of await currentMilestones(db, tx)) {
                        if (!['RELEASED', 'CANCELLED'].includes(m.status)) await db.milestones.update(m.id, { status: 'REFUNDED' });
                    }
                    await audit(
                        this.deps,
                        db,
                        this.providerActor,
                        'refund.completed',
                        { type: 'refund', id: refund.id },
                        { transactionId: tx.id, metadata: { eventId } }
                    );
                    await this.payments.notifyParties(db, tx, 'refund.completed');
                } else {
                    await db.refunds.update(refund.id, {
                        status: 'FAILED',
                        failureReason: typeof d.reason === 'string' ? truncateText(d.reason, 300) : 'Reported failed by partner',
                        updatedAt: now
                    });
                    await this.reverseAuthorization(db, `refund-auth:${refund.id}`, 'refund failed at partner');
                    await audit(
                        this.deps,
                        db,
                        this.providerActor,
                        'refund.failed',
                        { type: 'refund', id: refund.id },
                        { transactionId: tx.id, metadata: { eventId } }
                    );
                    await notifyRole(this.deps, db, 'finance_operator', 'refund.failed', { reference: tx.reference }, tx.id);
                }
                await this.workflow.autoAdvance(db, tx.id);
                await this.onSettlementProgress?.(db, tx.id);
                return { transactionId: tx.id };
            }
            case 'provider.error':
                await notifyRole(this.deps, db, 'finance_operator', 'provider.error', {});
                return { ignored: true };
            default:
                return { ignored: true };
        }
    }

    private async onFundsConfirmed(db: Db, eventId: string, event: VerifiedProviderEvent, tx: Transaction, instructionId: string) {
        const instruction = (await db.paymentInstructions.get(instructionId))!;
        if (instruction.status === 'FUNDED') return { transactionId: tx.id, ignored: true };
        const reportedMatches =
            event.data.amountMinor !== undefined &&
            BigInt(event.data.amountMinor) === instruction.amount.amountMinor &&
            event.data.currency === instruction.amount.currency;
        // The instruction must also be the one for the transaction as it stands: issued for the current
        // contract version (fund:<tx>:<version>[:<retry>]) and for the current amount. An amendment may have
        // superseded it (e.g. a late confirmation of a FAILED instruction, or one issued during the amendment).
        const fundingKey = `fund:${tx.id}:${tx.currentContractVersionId}`;
        const instructionCurrent =
            (instruction.idempotencyKey === fundingKey || instruction.idempotencyKey.startsWith(`${fundingKey}:`)) &&
            instruction.amount.amountMinor === tx.amount.amountMinor &&
            instruction.amount.currency === tx.amount.currency;
        if (!reportedMatches || !instructionCurrent) {
            // Never advance on a partial / different amount: route to finance & compliance.
            const now = this.deps.clock.now().toISOString();
            const fingerprint = `FUNDING_AMOUNT_MISMATCH:${eventId}`;
            // Idempotent: a reprocessed or redelivered event does not raise the alert twice.
            if (!(await db.riskAlerts.findOne({ fingerprint })))
                await db.riskAlerts.insert({
                    id: this.deps.ids.id(),
                    ruleId: 'FUNDING_AMOUNT_MISMATCH',
                    category: 'TRANSACTION',
                    severity: 'CRITICAL',
                    transactionId: tx.id,
                    fingerprint,
                    reasons: [
                        ...(reportedMatches
                            ? []
                            : [
                                  {
                                      code: 'REPORTED_AMOUNT_DIFFERS',
                                      params: {
                                          reportedMinor: event.data.amountMinor ?? 'n/a',
                                          reportedCurrency: event.data.currency ?? 'n/a',
                                          expectedMinor: instruction.amount.amountMinor.toString()
                                      }
                                  }
                              ]),
                        ...(instructionCurrent
                            ? []
                            : [
                                  {
                                      code: 'INSTRUCTION_NOT_CURRENT',
                                      params: {
                                          instructionMinor: instruction.amount.amountMinor.toString(),
                                          instructionCurrency: instruction.amount.currency,
                                          expectedMinor: tx.amount.amountMinor.toString(),
                                          expectedCurrency: tx.amount.currency
                                      }
                                  }
                              ])
                    ],
                    recommendedAction: 'CONTACT_PARTNER_AND_BUYER',
                    blocksFundsMovement: true,
                    status: 'OPEN',
                    createdAt: now,
                    updatedAt: now
                });
            await audit(
                this.deps,
                db,
                this.providerActor,
                'payment.amount_mismatch',
                { type: 'payment_instruction', id: instruction.id },
                { transactionId: tx.id, metadata: { eventId } }
            );
            await notifyRole(this.deps, db, 'finance_operator', 'payment.amount_mismatch', { reference: tx.reference }, tx.id);
            await notifyRole(this.deps, db, 'compliance_analyst', 'payment.amount_mismatch', { reference: tx.reference }, tx.id);
            return { transactionId: tx.id, error: reportedMatches ? 'INSTRUCTION_NOT_CURRENT' : 'AMOUNT_MISMATCH' };
        }
        // The instruction is FUNDED before the status update: the database refuses FUNDS_CONFIRMED without a
        // FUNDED instruction covering exactly the transaction's amount (transactions_before_update).
        const now = this.deps.clock.now().toISOString();
        await db.paymentInstructions.update(instruction.id, { status: 'FUNDED', updatedAt: now });
        await this.ledger.post(
            db,
            journalTemplates.fundsReportedReceived({
                provider: instruction.provider,
                transactionId: tx.id,
                currency: instruction.amount.currency,
                amountMinor: instruction.amount.amountMinor,
                externalReference: instruction.providerReference,
                providerEventId: eventId
            }),
            this.providerActor
        );
        await this.workflow.transition(db, tx, 'FUNDS_CONFIRMED', 'PROVIDER', this.providerActor, {
            extra: { reportedAmountMatches: true },
            patch: { fundedAt: now },
            metadata: { eventId }
        });
        await this.payments.notifyParties(db, tx, 'funds.confirmed');
        await this.workflow.autoAdvance(db, tx.id);
        return { transactionId: tx.id };
    }

    private async markMilestonesReleased(db: Db, tx: Transaction, milestoneId?: string, disputeDecisionId?: string) {
        if (milestoneId) {
            await db.milestones.update(milestoneId, { status: 'RELEASED' });
            return;
        }
        if (disputeDecisionId) {
            const decision = await db.disputeDecisions.get(disputeDecisionId);
            if (decision?.outcome === 'RELEASE_TO_SELLER') {
                for (const m of await currentMilestones(db, tx)) {
                    if (!['RELEASED', 'CANCELLED'].includes(m.status)) await db.milestones.update(m.id, { status: 'RELEASED' });
                }
            }
        }
    }

    private async reverseAuthorization(db: Db, idempotencyKey: string, reason: string) {
        const journal = await db.ledgerJournals.findOne({ idempotencyKey });
        if (!journal) return;
        const entries = await db.ledgerEntries.findBy({ journalId: journal.id });
        const accounts = new Map((await db.ledgerAccounts.list()).map((a) => [a.id, a.code]));
        await this.ledger.post(
            db,
            buildReversal(
                journal,
                entries.map((e) => ({
                    accountCode: accounts.get(e.accountId)!,
                    direction: e.direction,
                    amountMinor: e.amountMinor,
                    currency: e.currency
                })),
                reason
            ),
            this.providerActor
        );
    }
}
