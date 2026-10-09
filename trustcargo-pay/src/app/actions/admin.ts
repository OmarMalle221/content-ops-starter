'use server';
import type { ActionState } from '@/lib/action-state';
import { AppError } from '@/server/errors';
import { runAction, str } from './_run';

export async function reviewKycAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            (
                await app.identity.review(
                    actor,
                    str(form, 'verificationId'),
                    str(form, 'decision') === 'VERIFIED' ? 'VERIFIED' : 'REJECTED',
                    str(form, 'note')
                )
            ).status,
        {
            revalidate: ['/admin/verifications']
        }
    );
}

export async function reviewDocumentAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            (await app.documents.review(actor, str(form, 'documentId'), { decision: str(form, 'decision'), notes: str(form, 'notes') }))
                .status,
        {
            revalidate: ['/admin/documents']
        }
    );
}

export async function reviewRiskAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            (await app.risk.review(actor, str(form, 'alertId'), { decision: str(form, 'decision'), notes: str(form, 'notes') })).status,
        {
            revalidate: ['/admin/risk', `/admin/transactions/${str(form, 'transactionId')}`]
        }
    );
}

export async function placeHoldAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) =>
            (
                await app.compliance.placeHold(actor, id, {
                    type: str(form, 'type'),
                    reference: str(form, 'reference'),
                    notes: str(form, 'notes')
                })
            ).id,
        {
            revalidate: [`/admin/transactions/${id}`, '/admin/risk']
        }
    );
}

export async function liftHoldAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.compliance.liftHold(actor, str(form, 'holdId'), str(form, 'notes'))).status, {
        revalidate: [`/admin/transactions/${str(form, 'transactionId')}`, '/admin/risk']
    });
}

export async function assignDisputeAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.disputes.assign(actor, str(form, 'disputeId'))).status, {
        revalidate: ['/admin/disputes']
    });
}

export async function decideDisputeAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            (
                await app.disputes.decide(actor, str(form, 'disputeId'), {
                    outcome: str(form, 'outcome'),
                    sellerAmount: str(form, 'sellerAmount') || undefined,
                    rationale: str(form, 'rationale'),
                    contractClause: str(form, 'contractClause')
                })
            ).id,
        { revalidate: ['/admin/disputes', `/admin/transactions/${str(form, 'transactionId')}`] }
    );
}

export async function adminDisputeMessageAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            (await app.disputes.addMessage(actor, str(form, 'disputeId'), { body: str(form, 'body'), documentIds: [] })).id,
        {
            revalidate: [`/admin/transactions/${str(form, 'transactionId')}`]
        }
    );
}

export async function archiveDisputeAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.disputes.archive(actor, str(form, 'disputeId'))).status, {
        revalidate: ['/admin/disputes']
    });
}

export async function runReconciliationAction(_: ActionState) {
    return runAction(async ({ app, actor }) => (await app.reconciliation.run(actor)).status, { revalidate: ['/admin/ledger'] });
}

export async function injectDiscrepancyAction(_: ActionState) {
    return runAction(
        async ({ app, actor }) => {
            if (app.config.mode !== 'demo' || !actor.platformRoles.includes('finance_operator'))
                throw new AppError('FORBIDDEN', 'Demo only');
            app.mockProvider.injectStatementDiscrepancy({
                externalReference: `sim_unknown_${Date.now()}`,
                kind: 'FUNDS_RECEIVED',
                amountMinor: '250000',
                currency: 'CAD',
                occurredAt: new Date().toISOString()
            });
        },
        { revalidate: ['/admin/ledger'] }
    );
}

export async function reverseJournalAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.ledger.reverse(actor, str(form, 'journalId'), str(form, 'reason'))).id, {
        revalidate: ['/admin/ledger']
    });
}

export async function reprocessEventAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.providerEvents.reprocess(actor, str(form, 'eventId'))).status, {
        revalidate: ['/admin/partners']
    });
}

export async function retryReleasesAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(async ({ app, actor }) => app.payments.retryBlockedReleases(actor, id), { revalidate: [`/admin/transactions/${id}`] });
}

export async function updateCorridorAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            (
                await app.admin.updateCorridor(actor, str(form, 'corridorId'), {
                    enabled: str(form, 'enabled') === 'on',
                    reviewThreshold: str(form, 'reviewThreshold'),
                    reviewThresholdCurrency: str(form, 'reviewThresholdCurrency')
                })
            ).id,
        { revalidate: ['/admin/corridors'] }
    );
}

export async function updateSecurityAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) =>
            app.admin.updateSecuritySettings(actor, {
                payoutAccountCoolingOffHours: Number(str(form, 'payoutAccountCoolingOffHours')),
                sensitiveActionMfaMaxAgeMinutes: Number(str(form, 'sensitiveActionMfaMaxAgeMinutes'))
            }),
        { revalidate: ['/admin/security'] }
    );
}
