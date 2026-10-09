import { describe, expect, it } from 'vitest';
import { actors, createTestApp, withoutMfa } from './helpers';
import { dealerOrgId, payAllSubmitted, submitMilestone, toInProgress } from './flow';

describe('release controls and recovery', () => {
    it('blocks releases after a payout account change until the cooling-off period and review are over', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const org = await dealerOrgId(app);
        await expect(
            app.paymentAccounts.addOrReplace(
                withoutMfa(a.seller),
                { holderName: 'x', bankName: 'y', country: 'CA', currency: 'CAD', last4: '1234' },
                { type: 'ORGANIZATION', id: org }
            )
        ).rejects.toMatchObject({
            code: 'MFA_REQUIRED'
        });
        await app.paymentAccounts.addOrReplace(
            a.seller,
            {
                holderName: 'Autos Saint-Laurent Export inc.',
                bankName: 'Autre banque fictive',
                country: 'CA',
                currency: 'CAD',
                last4: '9911'
            },
            { type: 'ORGANIZATION', id: org }
        );
        const id = await submitMilestone(app, a.seller, txId, 0);
        const r = await app.milestones.review(a.buyer, txId, id, { decision: 'APPROVE' });
        expect(r.releaseBlockers).toEqual(expect.arrayContaining(['BLOCKING_RISK_ALERTS', 'PAYOUT_ACCOUNT_COOLING_OFF']));
        let v = await app.views.transaction(a.buyer, txId);
        expect(v.milestones[0]!.status).toBe('APPROVED');
        expect(v.payment!.payouts).toHaveLength(0);
        expect(v.underReview).toBe(true);

        app.clock.advance(73 * 3_600_000);
        const blocking = (await app.risk.listAlerts(a.compliance, { transactionId: txId })).filter(
            (x) => x.alert.blocksFundsMovement && x.alert.status === 'OPEN'
        );
        expect(blocking.map((x) => x.alert.ruleId).sort()).toEqual(['BENEFICIARY_CHANGED_RECENTLY', 'PAYMENT_DETAILS_CHANGED_IN_FLIGHT']);
        await app.risk.review(a.compliance, blocking[0]!.alert.id, {
            decision: 'RISK_MITIGATED',
            notes: 'Changement confirmé par téléphone au numéro connu (rappel sortant).'
        });
        expect((await app.views.transaction(a.buyer, txId)).payment!.payouts).toHaveLength(0);
        await app.risk.review(a.compliance, blocking[1]!.alert.id, {
            decision: 'RISK_MITIGATED',
            notes: 'Même vérification, même dossier.'
        });
        v = await app.views.transaction(a.buyer, txId);
        expect(v.payment!.payouts).toHaveLength(1);
        expect(v.payment!.payouts[0]!.status).toBe('SUBMITTED');
    });

    it('keeps a release REQUESTED during a partner outage and submits it on retry', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const id = await submitMilestone(app, a.seller, txId, 0);
        app.mockProvider.simulateOutage(1);
        await app.milestones.review(a.buyer, txId, id, { decision: 'APPROVE' });
        let v = await app.views.transaction(a.finance, txId);
        expect(v.payment!.payouts[0]).toMatchObject({ status: 'REQUESTED', attempts: 1 });
        expect(v.payment!.payouts[0]!.failureReason).toMatch(/Simulated partner error/);
        await expect(app.payments.retryBlockedReleases(a.buyer, txId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await app.payments.dispatchPending(txId);
        v = await app.views.transaction(a.finance, txId);
        expect(v.payment!.payouts[0]).toMatchObject({ status: 'SUBMITTED', attempts: 2 });
    });

    it('reverses the ledger authorisation when the partner reports a failed payout, and retries with a new instruction', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const id = await submitMilestone(app, a.seller, txId, 0);
        await app.milestones.review(a.buyer, txId, id, { decision: 'APPROVE' });
        const [transfer] = app.mockProvider.pendingTransfers();
        await app.mockProvider.simulateTransferOutcome(transfer!.reference, 'FAILED', 'Compte bénéficiaire fermé (simulation)');
        let v = await app.views.transaction(a.finance, txId);
        expect(v.payment!.payouts[0]!.status).toBe('FAILED');
        expect(v.payment!.heldMinor).toBe('1850000');
        const ledger = await app.admin.ledgerView(a.finance);
        expect(ledger.journals.some((j) => j.kind === 'REVERSAL')).toBe(true);
        const retry = await app.payments.retryBlockedReleases(a.finance, txId);
        expect(retry.created).toHaveLength(1);
        await payAllSubmitted(app);
        v = await app.views.transaction(a.finance, txId);
        expect(v.payment!.payouts.map((p) => p.status).sort()).toEqual(['CANCELLED', 'PAID']);
        expect(v.milestones[0]!.status).toBe('RELEASED');
        expect((await app.admin.overview(a.auditor)).trialBalance.every((t) => t.balanced)).toBe(true);
    });

    it('freezes all movements under a compliance hold, with four-eyes lifting', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        await expect(
            app.compliance.placeHold(withoutMfa(a.compliance), txId, {
                type: 'SANCTIONS_REVIEW',
                reference: 'CASE-1',
                notes: 'Correspondance potentielle'
            })
        ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        const hold = await app.compliance.placeHold(a.compliance, txId, {
            type: 'SANCTIONS_REVIEW',
            reference: 'CASE-1',
            notes: 'Correspondance potentielle à vérifier'
        });
        await expect(submitMilestone(app, a.seller, txId, 0)).rejects.toMatchObject({
            details: { failedGuards: ['COMPLIANCE_HOLD_ACTIVE'] }
        });
        const buyerView = await app.views.transaction(a.buyer, txId);
        expect(buyerView.holds).toBeUndefined();
        expect(buyerView.blockedReasons).toContain('UNDER_COMPLIANCE_REVIEW');
        await expect(app.compliance.liftHold(a.compliance, hold.id, 'Faux positif confirmé')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await app.compliance.liftHold(a.reviewer, hold.id, 'Faux positif confirmé par second analyste');
        await submitMilestone(app, a.seller, txId, 0);
    });
});

describe('disputes', () => {
    it('runs the adversarial process and refunds the buyer only after partner confirmation', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const m1 = await submitMilestone(app, a.seller, txId, 0);
        await app.milestones.review(a.buyer, txId, m1, { decision: 'APPROVE' });
        await payAllSubmitted(app);

        const { dispute } = await app.disputes.open(a.buyer, txId, {
            reason: 'NOT_DELIVERED',
            description: 'Le véhicule n’a pas été embarqué dans le délai contractuel de 21 jours.',
            requestedOutcome: 'Remboursement du solde'
        });
        await expect(
            app.disputes.open(a.seller, txId, {
                reason: 'CONTRACTUAL_DELAY',
                description: 'Deuxième litige en parallèle pour tester',
                requestedOutcome: 'x'
            })
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await expect(submitMilestone(app, a.seller, txId, 1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await app.disputes.addMessage(a.seller, dispute.id, { body: 'Retard du transporteur, nouvelle date proposée.' });
        let v = await app.views.transaction(a.buyer, txId);
        expect(v.disputes[0]!.status).toBe('UNDER_REVIEW');

        const decision = {
            outcome: 'REFUND_TO_BUYER',
            rationale: 'Le délai contractuel d’expédition est dépassé sans justification acceptée par l’acheteur.',
            contractClause: 'Délais — expédition 21 jours'
        };
        await expect(app.disputes.decide(a.buyer, dispute.id, decision)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(app.disputes.decide(withoutMfa(a.disputes), dispute.id, decision)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        await app.disputes.decide(a.disputes, dispute.id, decision);
        v = await app.views.transaction(a.buyer, txId);
        expect(v.status).toBe('REFUND_PENDING');
        expect(v.payment!.refunds[0]).toMatchObject({ status: 'SUBMITTED', amount: { amountMinor: '1665000', currency: 'CAD' } });
        expect(v.payment!.heldMinor).toBe('0');

        await payAllSubmitted(app);
        v = await app.views.transaction(a.buyer, txId);
        expect(v.status).toBe('REFUNDED');
        expect(v.disputes[0]!.status).toBe('RESOLVED');
        expect(v.milestones.map((m) => m.status)).toEqual(['RELEASED', 'REFUNDED', 'REFUNDED']);
        expect((await app.admin.overview(a.auditor)).trialBalance.every((t) => t.balanced)).toBe(true);
        expect((await app.reconciliation.run(a.finance)).status).toBe('MATCHED');
    });

    it('supports a split decision and a resume decision', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const { dispute } = await app.disputes.open(a.buyer, txId, {
            reason: 'NOT_AS_DESCRIBED',
            description: 'Kilométrage réel supérieur à celui déclaré dans l’annonce.',
            requestedOutcome: 'Réduction de prix'
        });
        await expect(
            app.disputes.decide(a.disputes, dispute.id, {
                outcome: 'SPLIT',
                sellerAmount: '18500',
                rationale: 'Montant égal au total, invalide pour un partage.',
                contractClause: 'Art. 4'
            })
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await app.disputes.decide(a.disputes, dispute.id, {
            outcome: 'SPLIT',
            sellerAmount: '17000',
            rationale: 'Réduction de 1 500 CAD reflétant l’écart de kilométrage constaté.',
            contractClause: 'Description du bien'
        });
        await payAllSubmitted(app);
        const v = await app.views.transaction(a.seller, txId);
        expect(v.status).toBe('REFUNDED');
        expect(v.payment!.payouts[0]!.amount.amountMinor).toBe('1700000');
        expect(v.payment!.refunds[0]!.amount.amountMinor).toBe('150000');

        const app2 = await createTestApp();
        const b = await actors(app2);
        const t2 = await toInProgress(app2, b.seller, b.buyer);
        const d2 = await app2.disputes.open(b.seller, t2.txId, {
            reason: 'INSPECTION_DISAGREEMENT',
            description: 'Désaccord sur les conclusions de l’inspection initiale.',
            requestedOutcome: 'Contre-expertise'
        });
        await app2.disputes.decide(b.disputes, d2.dispute.id, {
            outcome: 'RESUME',
            rationale: 'Contre-expertise conforme ; la transaction reprend normalement.',
            contractClause: 'Inspection'
        });
        expect((await app2.views.transaction(b.seller, t2.txId)).status).toBe('IN_PROGRESS');
    });

    it('lets the opener withdraw before a decision', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        await submitMilestone(app, a.seller, txId, 0);
        const { dispute } = await app.disputes.open(a.buyer, txId, {
            reason: 'CONTRACTUAL_DELAY',
            description: 'Retard de transmission du rapport d’inspection.',
            requestedOutcome: 'Information'
        });
        await expect(app.disputes.withdraw(a.seller, dispute.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect((await app.disputes.withdraw(a.buyer, dispute.id)).status).toBe('MILESTONE_REVIEW');
    });
});
