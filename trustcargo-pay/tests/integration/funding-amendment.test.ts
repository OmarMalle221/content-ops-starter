/**
 * A contract amendment supersedes the payment instructions issued for the previous version: the partner's
 * confirmation of such an instruction never confirms the funding of the amended transaction. Runs on both
 * adapters; on Postgres the transactions_before_update trigger refuses it as well.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { actors, createTestApp } from './helpers';
import { agree, createAndInvite } from './flow';

async function amendPrice(app: App, seller: Actor, txId: string, amount: string) {
    const view = await app.views.transaction(seller, txId);
    return app.transactions.amendContract(seller, txId, {
        price: { amount, currency: 'CAD' },
        terms: { ...view.contract!.terms, deadlines: view.contract!.terms.deadlines },
        milestones: view.contract!.terms.milestones,
        changeSummary: 'Prix révisé'
    });
}

async function awaitingFunding(app: App) {
    const a = await actors(app);
    const { tx, token } = await createAndInvite(app, a.seller);
    await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
    await agree(app, a.seller, a.buyer, tx.id);
    return { a, txId: tx.id };
}

describe('funding instructions superseded by a contract amendment', () => {
    it('records an instruction issued while the contract was amended as CANCELLED, and its funding confirms nothing', async () => {
        const app = await createTestApp();
        const { a, txId } = await awaitingFunding(app);
        // The seller amends the price while the buyer's instruction is being issued by the partner.
        const issue = app.mockProvider.createPaymentInstruction.bind(app.mockProvider);
        vi.spyOn(app.mockProvider, 'createPaymentInstruction').mockImplementationOnce(async (request) => {
            const issued = await issue(request);
            expect((await amendPrice(app, a.seller, txId, '18600')).status).toBe('AWAITING_AGREEMENT');
            return issued;
        });
        await expect(app.payments.requestFundingInstructions(a.buyer, txId)).rejects.toMatchObject({ code: 'CONFLICT' });
        const [stale] = await app.deps.uow.run((db) => db.paymentInstructions.findBy({ transactionId: txId }));
        expect(stale).toMatchObject({ status: 'CANCELLED', failureReason: 'Superseded by contract amendment' });
        expect(stale!.amount.amountMinor).toBe(1_850_000n);
        expect(stale!.providerReference).toMatch(/^sim_pi_/);

        // Both parties accept the amended contract; the buyer then pays the stale instruction anyway.
        expect((await agree(app, a.seller, a.buyer, txId)).status).toBe('AWAITING_FUNDING');
        await app.mockProvider.simulateFunding(stale!.providerReference);
        const view = await app.views.transaction(a.finance, txId);
        expect(view.status).toBe('AWAITING_FUNDING');
        expect(view.payment!.heldMinor).toBe('0');
        const events = await app.admin.providerEvents(a.finance);
        expect(events.find((e) => e.type === 'funds.confirmed')).toMatchObject({ status: 'FAILED' });

        // The instruction for the amended price funds the transaction normally.
        const current = await app.payments.requestFundingInstructions(a.buyer, txId);
        expect(current.amount.amountMinor).toBe(1_860_000n);
        await app.mockProvider.simulateFunding(current.providerReference);
        expect((await app.views.transaction(a.buyer, txId)).payment!.heldMinor).toBe('1860000');
    });

    it('never confirms funds reported on an instruction of a previous contract version', async () => {
        const app = await createTestApp();
        const { a, txId } = await awaitingFunding(app);
        const first = await app.payments.requestFundingInstructions(a.buyer, txId);
        await app.mockProvider.simulateFundingFailure(first.providerReference);
        expect((await amendPrice(app, a.seller, txId, '18600')).status).toBe('AWAITING_AGREEMENT');
        expect((await agree(app, a.seller, a.buyer, txId)).status).toBe('AWAITING_FUNDING');

        // A late confirmation of the FAILED v1 instruction (18,500 CAD), exactly for its own amount.
        await app.mockProvider.simulateFunding(first.providerReference);
        const view = await app.views.transaction(a.compliance, txId);
        expect(view.status).toBe('AWAITING_FUNDING');
        expect(view.payment!.heldMinor).toBe('0');
        const alert = view.risk!.find((r) => r.ruleId === 'FUNDING_AMOUNT_MISMATCH');
        expect(alert?.reasons).toEqual([
            {
                code: 'INSTRUCTION_NOT_CURRENT',
                params: { instructionMinor: '1850000', instructionCurrency: 'CAD', expectedMinor: '1860000', expectedCurrency: 'CAD' }
            }
        ]);
        const events = await app.admin.providerEvents(a.finance);
        expect(events.find((e) => e.type === 'funds.confirmed')).toMatchObject({ status: 'FAILED', error: 'INSTRUCTION_NOT_CURRENT' });
    });
});
