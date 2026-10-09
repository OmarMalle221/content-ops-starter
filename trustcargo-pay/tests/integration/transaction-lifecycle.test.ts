import { describe, expect, it } from 'vitest';
import { actors, createTestApp } from './helpers';
import { agree, createAndInvite, dealerOrgId, input, payAllSubmitted, pdf, submitMilestone, toInProgress } from './flow';

describe('vehicle transaction lifecycle', () => {
    it('goes from draft to completed with milestone releases confirmed by the partner', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx, token } = await createAndInvite(app, a.seller);
        expect(tx.status).toBe('DRAFT');
        expect((await app.views.transaction(a.seller, tx.id)).status).toBe('AWAITING_PARTIES');

        expect((await app.transactions.acceptInvitation(a.buyer, token('BUYER'))).status).toBe('AWAITING_AGREEMENT');
        expect((await agree(app, a.seller, a.buyer, tx.id)).status).toBe('AWAITING_FUNDING');

        const instruction = await app.payments.requestFundingInstructions(a.buyer, tx.id);
        expect(instruction.details.notes).toMatch(/SIMULATION/);
        // Idempotent: asking again returns the same instruction
        expect((await app.payments.requestFundingInstructions(a.buyer, tx.id)).id).toBe(instruction.id);

        await app.mockProvider.simulateFunding(instruction.providerReference, { stopAt: 'pending' });
        expect((await app.views.transaction(a.buyer, tx.id)).status).toBe('FUNDING_PENDING');
        await app.mockProvider.simulateFunding(instruction.providerReference);
        let view = await app.views.transaction(a.buyer, tx.id);
        expect(view.status).toBe('IN_PROGRESS');
        expect(view.payment!.heldMinor).toBe('1850000');
        expect(view.milestones[0]!.status).toBe('ACTIVE');

        for (const i of [0, 1, 2]) {
            const id = await submitMilestone(app, a.seller, tx.id, i);
            const r = await app.milestones.review(a.buyer, tx.id, id, { decision: 'APPROVE' });
            expect(r.releaseBlockers).toEqual([]);
            await payAllSubmitted(app);
        }
        view = await app.views.transaction(a.buyer, tx.id);
        expect(view.status).toBe('COMPLETED');
        expect(view.payment!.heldMinor).toBe('0');
        expect(view.payment!.payouts.map((p) => p.amount.amountMinor).sort()).toEqual(['185000', '740000', '925000']);
        expect((await app.admin.overview(a.auditor)).trialBalance.every((t) => t.balanced)).toBe(true);
    });

    it('requires both parties to accept again after an amendment and rejects stale acceptances', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx, token } = await createAndInvite(app, a.seller);
        await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
        await agree(app, a.seller, a.buyer, tx.id);
        const before = await app.views.transaction(a.buyer, tx.id);
        const amended = await app.transactions.amendContract(a.seller, tx.id, {
            price: { amount: '18000', currency: 'CAD' },
            terms: { ...before.contract!.terms, deadlines: before.contract!.terms.deadlines },
            milestones: before.contract!.terms.milestones,
            changeSummary: 'Remise de 500 CAD après inspection'
        });
        expect(amended.status).toBe('AWAITING_AGREEMENT');
        const after = await app.views.transaction(a.buyer, tx.id);
        expect(after.contract!.versionNumber).toBe(2);
        expect(after.contract!.acceptances).toEqual([]);
        expect(after.contract!.changedFields).toContain('totalAmount');
        expect(after.milestones.map((m) => m.amount.amountMinor)).toEqual(['180000', '720000', '900000']);
        // Accepting with the old hash (what the buyer saw before) is refused
        await expect(
            app.transactions.decideContract(a.buyer, tx.id, {
                contractVersionId: before.contract!.currentVersionId,
                contentHash: before.contract!.contentHash,
                decision: 'ACCEPTED'
            })
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await agree(app, a.seller, a.buyer, tx.id)).status).toBe('AWAITING_FUNDING');
    });

    it('blocks contract acceptance until identity is verified, then advances automatically', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx } = await createAndInvite(app, a.seller, {
            buyer: { fullName: 'Cheikh Fall', email: 'cheikh.fall@demo.trustcargo.test' }
        });
        const [invitation] = await app.transactions.pendingInvitations(a.buyer2);
        expect((await app.transactions.acceptInvitationForParty(a.buyer2, invitation!.partyId)).status).toBe('IDENTITY_VERIFICATION');
        const v = await app.views.transaction(a.buyer2, tx.id);
        await expect(
            app.transactions.decideContract(a.buyer2, tx.id, {
                contractVersionId: v.contract!.currentVersionId,
                contentHash: v.contract!.contentHash,
                decision: 'ACCEPTED'
            })
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        const kyc = await app.identity.start(a.buyer2);
        await app.identity.complete(a.buyer2, kyc.id, 'APPROVE');
        expect((await app.views.transaction(a.buyer2, tx.id)).status).toBe('AWAITING_AGREEMENT');
        expect((await agree(app, a.seller, a.buyer2, tx.id)).status).toBe('AWAITING_FUNDING');
    });

    it('does not let the buyer fund before the seller provided the pre-funding documents', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const tx = await app.transactions.createVehicleTransaction(a.seller, input({ sellerOrganizationId: await dealerOrgId(app) }));
        const { links } = await app.transactions.sendInvitations(a.seller, tx.id);
        await app.transactions.acceptInvitation(a.buyer, links[0]!.url.split('/invite/')[1]!);
        await agree(app, a.seller, a.buyer, tx.id);
        await expect(app.payments.requestFundingInstructions(a.buyer, tx.id)).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED',
            details: { failedGuards: ['REQUIRED_DOCUMENTS_MISSING'], missing: ['TITLE', 'INVOICE'] }
        });
        await app.documents.upload(a.seller, { transactionId: tx.id, type: 'TITLE', title: 'Titre' }, pdf('titre'));
        await app.documents.upload(a.seller, { transactionId: tx.id, type: 'INVOICE', title: 'Facture' }, pdf('facture'));
        expect((await app.payments.requestFundingInstructions(a.buyer, tx.id)).status).toBe('CREATED');
    });

    it('lets the buyer request changes and the seller resubmit', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const id = await submitMilestone(app, a.seller, txId, 0);
        await expect(app.milestones.review(a.buyer, txId, id, { decision: 'REQUEST_CHANGES' })).rejects.toMatchObject({
            code: 'VALIDATION'
        });
        await app.milestones.review(a.buyer, txId, id, { decision: 'REQUEST_CHANGES', reason: 'Photos du compartiment moteur manquantes' });
        let v = await app.views.transaction(a.seller, txId);
        expect(v.status).toBe('IN_PROGRESS');
        expect(v.milestones[0]).toMatchObject({
            status: 'CHANGES_REQUESTED',
            changeRequestReason: 'Photos du compartiment moteur manquantes'
        });
        await app.milestones.submit(a.seller, txId, id, 'Photos ajoutées');
        v = await app.views.transaction(a.seller, txId);
        expect(v.status).toBe('MILESTONE_REVIEW');
    });

    it('refuses milestone submission without the contractually required evidence', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const v = await app.views.transaction(a.seller, txId);
        await expect(app.milestones.submit(a.seller, txId, v.milestones[0]!.id)).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED',
            details: { failedGuards: ['MISSING_REQUIRED_EVIDENCE'] }
        });
    });
});
