'use server';
import type { ActionState } from '@/lib/action-state';
import { AppError } from '@/server/errors';
import { hasRole } from '@/server/auth/actor';
import { runAction, str } from './_run';

const MIN = 60_000;
const txPath = (id: string) => `/transactions/${id}`;

function json<T>(form: FormData, key: string): T {
    try {
        return JSON.parse(str(form, key)) as T;
    } catch {
        throw new AppError('VALIDATION', 'Malformed payload');
    }
}

export async function createTransactionAction(
    _: ActionState,
    form: FormData
): Promise<ActionState<{ id: string; links: { role: string; email: string; url: string }[] }>> {
    return runAction(
        async ({ app, actor }) => {
            const tx = await app.transactions.createVehicleTransaction(actor, json(form, 'payload'));
            const { links } = await app.transactions.sendInvitations(actor, tx.id);
            if (str(form, 'acceptTerms') === 'on') {
                const user = await app.deps.uow.run((db) => db.users.get(actor.userId));
                if (user?.kycStatus === 'VERIFIED') {
                    const view = await app.views.transaction(actor, tx.id);
                    await app.transactions.decideContract(actor, tx.id, {
                        contractVersionId: view.contract!.currentVersionId,
                        contentHash: view.contract!.contentHash,
                        decision: 'ACCEPTED'
                    });
                }
            }
            return { id: tx.id, links: links.map((l) => ({ role: l.role, email: l.email, url: l.url })) };
        },
        { revalidate: ['/transactions', '/dashboard'], rateLimit: { key: 'create-tx', limit: 20, windowMs: 60 * MIN } }
    );
}

export async function sendInvitationsAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) =>
            (await app.transactions.sendInvitations(actor, id)).links.map((l) => ({ role: l.role, email: l.email, url: l.url })),
        { revalidate: [txPath(id)] }
    );
}

export async function regenerateInvitationAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => {
            const l = await app.transactions.regenerateInvitation(actor, id, str(form, 'partyId'));
            return [{ role: l.role, email: l.email, url: l.url }];
        },
        { revalidate: [txPath(id)], rateLimit: { key: 'regen-invite', limit: 10, windowMs: 10 * MIN } }
    );
}

export async function acceptInvitationAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.transactions.acceptInvitation(actor, str(form, 'token'))).id, {
        rateLimit: { key: 'invite', limit: 20, windowMs: 10 * MIN }
    });
}

export async function acceptInvitationForPartyAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => (await app.transactions.acceptInvitationForParty(actor, str(form, 'partyId'))).id, {
        revalidate: ['/dashboard']
    });
}

export async function declineInvitationAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) =>
        app.transactions.declineInvitation(actor, str(form, 'token'), str(form, 'reason') || undefined)
    );
}

export async function cancelTransactionAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(async ({ app, actor }) => (await app.transactions.cancel(actor, id, str(form, 'reason'))).status, {
        revalidate: [txPath(id)]
    });
}

export async function decideContractAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) =>
            (
                await app.transactions.decideContract(actor, id, {
                    contractVersionId: str(form, 'contractVersionId'),
                    contentHash: str(form, 'contentHash'),
                    decision: str(form, 'decision'),
                    comment: str(form, 'comment') || undefined
                })
            ).status,
        { revalidate: [txPath(id)] }
    );
}

export async function amendContractAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(async ({ app, actor }) => (await app.transactions.amendContract(actor, id, json(form, 'payload'))).status, {
        revalidate: [txPath(id)]
    });
}

export async function requestFundingAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(async ({ app, actor }) => (await app.payments.requestFundingInstructions(actor, id)).id, {
        revalidate: [txPath(id)],
        rateLimit: { key: 'funding', limit: 10, windowMs: 10 * MIN }
    });
}

export async function uploadDocumentAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => {
            const file = form.get('file');
            if (!(file instanceof File) || file.size === 0) throw new AppError('VALIDATION', 'File required');
            const extracted: Record<string, string> = {};
            for (const k of [
                'vin',
                'ownerName',
                'amount',
                'amountCurrency',
                'consignee',
                'shipper',
                'portOfLoading',
                'portOfDischarge',
                'documentNumber',
                'issueDate'
            ]) {
                const v = str(form, `x_${k}`).trim();
                if (v) extracted[k] = v;
            }
            const doc = await app.documents.upload(
                actor,
                {
                    transactionId: id,
                    type: str(form, 'type'),
                    title: str(form, 'title'),
                    replacesDocumentId: str(form, 'replacesDocumentId') || undefined,
                    milestoneId: str(form, 'milestoneId') || undefined,
                    extracted
                },
                { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, declaredMimeType: file.type }
            );
            return { id: doc.id, status: doc.status };
        },
        { revalidate: [txPath(id)], rateLimit: { key: 'upload', limit: 40, windowMs: 10 * MIN } }
    );
}

export async function documentUrlAction(_: ActionState, form: FormData) {
    return runAction(async ({ app, actor }) => app.documents.issueSignedUrl(actor, str(form, 'documentId')), {
        rateLimit: { key: 'doc-url', limit: 60, windowMs: MIN }
    });
}

export async function attachEvidenceAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => app.milestones.attachEvidence(actor, id, str(form, 'milestoneId'), str(form, 'documentId')),
        { revalidate: [txPath(id)] }
    );
}

export async function submitMilestoneAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => (await app.milestones.submit(actor, id, str(form, 'milestoneId'), str(form, 'note') || undefined)).status,
        { revalidate: [txPath(id)] }
    );
}

export async function reviewMilestoneAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => {
            const r = await app.milestones.review(actor, id, str(form, 'milestoneId'), {
                decision: str(form, 'decision'),
                reason: str(form, 'reason') || undefined
            });
            return { status: r.transaction.status, releaseBlockers: r.releaseBlockers };
        },
        { revalidate: [txPath(id)] }
    );
}

export async function openDisputeAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) =>
            (
                await app.disputes.open(actor, id, {
                    reason: str(form, 'reason'),
                    description: str(form, 'description'),
                    requestedOutcome: str(form, 'requestedOutcome'),
                    milestoneId: str(form, 'milestoneId') || undefined
                })
            ).dispute.id,
        { revalidate: [txPath(id)], rateLimit: { key: 'dispute', limit: 5, windowMs: 60 * MIN } }
    );
}

export async function disputeMessageAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) =>
            (
                await app.disputes.addMessage(actor, str(form, 'disputeId'), {
                    body: str(form, 'body'),
                    documentIds: form.getAll('documentIds').filter((x): x is string => typeof x === 'string')
                })
            ).id,
        {
            revalidate: [txPath(id)],
            rateLimit: { key: 'dispute-msg', limit: 30, windowMs: 10 * MIN }
        }
    );
}

export async function withdrawDisputeAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(async ({ app, actor }) => (await app.disputes.withdraw(actor, str(form, 'disputeId'))).status, {
        revalidate: [txPath(id)]
    });
}

/* ------------------------------------------------------------------ demo partner simulator */

async function assertSimulatorAccess(
    app: Awaited<ReturnType<typeof import('@/server/instance').getApp>>,
    actor: Parameters<typeof hasRole>[0],
    transactionId: string
) {
    if (app.config.mode !== 'demo') throw new AppError('FORBIDDEN', 'Simulator disabled');
    const view = await app.views.transaction(actor, transactionId);
    if (!view.can.simulatePartner) throw new AppError('FORBIDDEN', 'Simulator not available');
    return view;
}

export async function simulateFundingAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => {
            const view = await assertSimulatorAccess(app, actor, id);
            const ref = view.simulator?.instructionReference;
            if (!ref) throw new AppError('PRECONDITION_FAILED', 'No pending instruction');
            const mode = str(form, 'mode');
            if (mode === 'fail') await app.mockProvider.simulateFundingFailure(ref);
            else if (mode === 'wrong') await app.mockProvider.simulateFunding(ref, { amountMinor: BigInt(view.amount.amountMinor) / 2n });
            else await app.mockProvider.simulateFunding(ref);
        },
        { revalidate: [txPath(id)] }
    );
}

export async function simulateTransferAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(
        async ({ app, actor }) => {
            const view = await assertSimulatorAccess(app, actor, id);
            const ref = str(form, 'reference');
            if (!view.simulator?.transfers.some((t) => t.reference === ref)) throw new AppError('NOT_FOUND', 'Transfer not found');
            await app.mockProvider.simulateTransferOutcome(
                ref,
                str(form, 'outcome') === 'FAILED' ? 'FAILED' : 'PAID',
                str(form, 'outcome') === 'FAILED' ? 'Compte bénéficiaire refusé (simulation)' : undefined
            );
        },
        { revalidate: [txPath(id)] }
    );
}

export async function simulateOutageAction(_: ActionState, form: FormData) {
    const id = str(form, 'transactionId');
    return runAction(async ({ app, actor }) => {
        await assertSimulatorAccess(app, actor, id);
        app.mockProvider.simulateOutage(1);
    });
}
