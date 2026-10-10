/**
 * Late, redelivered or out-of-order partner events never move money state twice (both adapters; Postgres with
 * scripts/test-integration-pg.sh). An event that no longer fits the record is audited and ignored; one that
 * contradicts a settled transfer is also sent to finance for review.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { RECEIVED_GRACE_MS } from '@/server/services/provider-event-service';
import { actors, createTestApp } from './helpers';
import { agree, createAndInvite, submitMilestone, toInProgress } from './flow';

async function awaitingFunding(app: App) {
    const a = await actors(app);
    const { tx, token } = await createAndInvite(app, a.seller);
    await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
    await agree(app, a.seller, a.buyer, tx.id);
    return { a, txId: tx.id };
}

async function amendPrice(app: App, seller: Actor, txId: string, amount: string) {
    const view = await app.views.transaction(seller, txId);
    return app.transactions.amendContract(seller, txId, {
        price: { amount, currency: 'CAD' },
        terms: view.contract!.terms,
        milestones: view.contract!.terms.milestones,
        changeSummary: 'Prix révisé'
    });
}

const notifications = (app: App, type: string) => app.deps.uow.run((db) => db.notifications.findBy({ type }));
const auditActions = async (app: App, auditor: Actor, txId: string) =>
    (await app.admin.auditLog(auditor, { transactionId: txId })).events.map((e) => e.action);
const instructionOf = (app: App, providerReference: string) =>
    app.deps.uow.run(async (db) => (await db.paymentInstructions.findOne({ providerReference }))!);

describe('late and out-of-order partner events', () => {
    it('never lets a payment.failed recovered after the funds were confirmed undo them', async () => {
        const app = await createTestApp();
        const { a, txId } = await awaitingFunding(app);
        const instruction = await app.payments.requestFundingInstructions(a.buyer, txId);
        await app.mockProvider.simulateFunding(instruction.providerReference, { stopAt: 'pending' });
        expect((await app.views.transaction(a.buyer, txId)).status).toBe('FUNDING_PENDING');

        // The failure is recorded (RECEIVED) but its processing never completes (crash between the two units of work).
        const processing = vi
            .spyOn(app.providerEvents as unknown as { process: () => Promise<unknown> }, 'process')
            .mockRejectedValueOnce(new Error('crash'));
        let failedBody = '';
        const deliver = app.providerEvents.ingest.bind(app.providerEvents);
        app.mockProvider.setDelivery((raw, header) => {
            if (raw.includes('"payment.failed"')) failedBody = raw;
            return deliver(raw, header);
        });
        await expect(app.mockProvider.simulateFundingFailure(instruction.providerReference)).rejects.toThrow('crash');
        processing.mockRestore();

        // The partner then confirms the funds: the transaction is funded.
        await app.mockProvider.simulateFunding(instruction.providerReference);
        expect((await app.views.transaction(a.buyer, txId)).status).toBe('IN_PROGRESS');

        // Past the grace period the partner redelivers the failure: recovered, but it no longer fits the record.
        app.clock.advance(RECEIVED_GRACE_MS + 1_000);
        expect(await app.mockProvider.replay(failedBody)).toMatchObject({ status: 'processed' });
        expect(await instructionOf(app, instruction.providerReference)).toMatchObject({ status: 'FUNDED' });
        const view = await app.views.transaction(a.buyer, txId);
        expect(view).toMatchObject({ status: 'IN_PROGRESS', payment: { heldMinor: '1850000', instruction: { status: 'FUNDED' } } });
        expect(await notifications(app, 'payment.failed')).toEqual([]);
        const events = await app.admin.providerEvents(a.finance);
        expect(events.find((e) => e.type === 'payment.failed')).toMatchObject({ status: 'IGNORED' });
        expect(await auditActions(app, a.auditor, txId)).toContain('provider_event.stale_instruction_ignored');
    });

    it('ignores progress reported after an instruction failed: the transaction stays open for a new instruction', async () => {
        const app = await createTestApp();
        const { a, txId } = await awaitingFunding(app);
        const first = await app.payments.requestFundingInstructions(a.buyer, txId);
        await app.mockProvider.simulateFundingFailure(first.providerReference);
        const retry = await app.payments.requestFundingInstructions(a.buyer, txId);
        expect(retry.id).not.toBe(first.id);
        // The buyer asks again: the open retry is returned, never a second payable instruction.
        expect((await app.payments.requestFundingInstructions(a.buyer, txId)).id).toBe(retry.id);

        // Late progress of the failed instruction.
        await app.mockProvider.simulateFunding(first.providerReference, { stopAt: 'pending' });
        expect((await app.views.transaction(a.buyer, txId)).status).toBe('AWAITING_FUNDING');
        expect(await instructionOf(app, first.providerReference)).toMatchObject({ status: 'FAILED' });

        await app.mockProvider.simulateFunding(retry.providerReference);
        expect((await app.views.transaction(a.buyer, txId)).payment!.heldMinor).toBe('1850000');
    });

    it('ignores progress reported on an instruction superseded by an amendment, which stays amendable', async () => {
        const app = await createTestApp();
        const { a, txId } = await awaitingFunding(app);
        const first = await app.payments.requestFundingInstructions(a.buyer, txId);
        await app.mockProvider.simulateFundingFailure(first.providerReference);
        expect((await amendPrice(app, a.seller, txId, '18600')).status).toBe('AWAITING_AGREEMENT');
        expect((await agree(app, a.seller, a.buyer, txId)).status).toBe('AWAITING_FUNDING');
        const current = await app.payments.requestFundingInstructions(a.buyer, txId);

        await app.mockProvider.simulateFunding(first.providerReference, { stopAt: 'pending' });
        expect((await app.views.transaction(a.buyer, txId)).status).toBe('AWAITING_FUNDING');
        const events = await app.admin.providerEvents(a.finance);
        expect(events.filter((e) => e.type === 'payment.initiated' || e.type === 'payment.pending').map((e) => e.status)).toEqual([
            'IGNORED',
            'IGNORED'
        ]);
        // Nothing is locked: the seller can still amend, and the current instruction funds the transaction.
        expect((await amendPrice(app, a.seller, txId, '18700')).status).toBe('AWAITING_AGREEMENT');
        expect((await agree(app, a.seller, a.buyer, txId)).status).toBe('AWAITING_FUNDING');
        expect(await instructionOf(app, current.providerReference)).toMatchObject({ status: 'CANCELLED' });
        const latest = await app.payments.requestFundingInstructions(a.buyer, txId);
        await app.mockProvider.simulateFunding(latest.providerReference);
        expect((await app.views.transaction(a.buyer, txId)).payment!.heldMinor).toBe('1870000');
    });

    it('applies the current-instruction rule itself: a superseded instruction still open never moves the transaction', async () => {
        const app = await createTestApp();
        const { a, txId } = await awaitingFunding(app);
        const first = await app.payments.requestFundingInstructions(a.buyer, txId);
        await app.mockProvider.simulateFundingFailure(first.providerReference);
        await amendPrice(app, a.seller, txId, '18600');
        await agree(app, a.seller, a.buyer, txId);
        await app.payments.requestFundingInstructions(a.buyer, txId);
        // No workflow leaves a superseded instruction open today (an amendment cancels CREATED ones and is refused
        // while one is PENDING): forced here, to check the rule rather than the workflow.
        await app.deps.uow.run(async (db) => db.paymentInstructions.update(first.id, { status: 'PENDING' }));
        await app.mockProvider.simulateFunding(first.providerReference, { stopAt: 'pending' });
        expect((await app.views.transaction(a.buyer, txId)).status).toBe('AWAITING_FUNDING');

        // Its failure closes it, without telling the parties their (current) payment failed.
        await app.mockProvider.simulateFundingFailure(first.providerReference);
        expect(await instructionOf(app, first.providerReference)).toMatchObject({ status: 'FAILED' });
        expect((await app.views.transaction(a.buyer, txId)).status).toBe('AWAITING_FUNDING');
        expect(await notifications(app, 'payment.failed')).toHaveLength(2); // the v1 failure, to buyer and seller
    });

    it('sends a payout reported paid after its failure to finance review, without moving the books', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const milestoneId = await submitMilestone(app, a.seller, txId, 0);
        await app.milestones.review(a.buyer, txId, milestoneId, { decision: 'APPROVE' });
        const [transfer] = await app.mockProvider.pendingTransfers();
        await app.mockProvider.simulateTransferOutcome(transfer!.reference, 'FAILED', 'Compte fermé (simulation)');
        const before = await app.admin.ledgerView(a.finance);
        // A repeat of the recorded outcome is a plain duplicate.
        await app.mockProvider.simulateTransferOutcome(transfer!.reference, 'FAILED');
        expect(await notifications(app, 'provider_event.needs_review')).toEqual([]);

        // The partner then reports the same payout paid: contradicting, never applied.
        await app.mockProvider.simulateTransferOutcome(transfer!.reference, 'PAID');
        const view = await app.views.transaction(a.finance, txId);
        expect(view.payment!.payouts.map((p) => p.status)).toEqual(['FAILED']);
        expect(view.payment!.heldMinor).toBe('1850000');
        expect((await app.admin.ledgerView(a.finance)).journals).toHaveLength(before.journals.length);
        expect((await notifications(app, 'provider_event.needs_review')).length).toBeGreaterThan(0);
        expect(await auditActions(app, a.auditor, txId)).toContain('provider_event.contradicts_settlement');
        const events = (await app.admin.providerEvents(a.finance)).filter((e) => e.type.startsWith('payout.'));
        expect(events.map((e) => [e.type, e.status]).sort()).toEqual([
            ['payout.failed', 'IGNORED'],
            ['payout.failed', 'PROCESSED'],
            ['payout.paid', 'IGNORED']
        ]);
    });
});
