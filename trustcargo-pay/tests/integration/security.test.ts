import { describe, expect, it } from 'vitest';
import { signPayload } from '@/server/security/webhook-signature';
import { actors, createTestApp } from './helpers';
import { createAndInvite, pdf, toInProgress, submitMilestone } from './flow';

describe('isolation between users and organisations', () => {
    it('hides a transaction and its documents from an outsider (404, not 403) and logs denied access', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const outsider = a.buyer2;
        await expect(app.views.transaction(outsider, txId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(app.documents.listForTransaction(outsider, txId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(app.documents.comparison(outsider, txId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect((await app.transactions.listForActor(outsider)).map((x) => x.transaction.id)).not.toContain(txId);

        const docs = await app.documents.listForTransaction(a.buyer, txId);
        const invoice = docs.find((d) => d.type === 'INVOICE')!;
        await expect(app.documents.issueSignedUrl(outsider, invoice.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        // A URL signed for the buyer cannot be used by someone else
        const { url } = await app.documents.issueSignedUrl(a.buyer, invoice.id);
        const u = new URL(url, 'http://x');
        await expect(
            app.documents.readContent(outsider, invoice.id, u.searchParams.get('exp'), u.searchParams.get('sig'))
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const content = await app.documents.readContent(a.buyer, invoice.id, u.searchParams.get('exp'), u.searchParams.get('sig'));
        expect(content.mimeType).toBe('application/pdf');
        const log = await app.documents.accessLog(a.compliance, invoice.id);
        expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['DENIED', 'SIGNED_URL_ISSUED', 'DOWNLOAD']));
    });

    it('limits an inspector to the documents and data their role needs', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx, token } = await createAndInvite(app, a.seller, {
            inspector: { fullName: 'Marie-Ève Gagnon', email: 'marie-eve.gagnon@demo.trustcargo.test' }
        });
        await app.transactions.acceptInvitation(a.inspector, token('INSPECTOR'));
        const view = await app.views.transaction(a.inspector, tx.id);
        expect(view.payment).toBeUndefined();
        expect(view.documents.map((d) => d.type)).toEqual(['TITLE']);
        expect(view.can.uploadableTypes).toEqual(['INSPECTION_REPORT', 'PHOTO']);
        await expect(app.documents.upload(a.inspector, { transactionId: tx.id, type: 'INVOICE', title: 'x' }, pdf())).rejects.toMatchObject(
            { code: 'FORBIDDEN' }
        );
        const invoiceId = (await app.documents.listForTransaction(a.seller, tx.id)).find((d) => d.type === 'INVOICE')!.id;
        await expect(app.documents.issueSignedUrl(a.inspector, invoiceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(app.transactions.cancel(a.inspector, tx.id, 'no')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('applies least privilege to staff: platform admins cannot read transactions, auditors cannot open files', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        await expect(app.views.transaction(a.admin, txId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(app.admin.listTransactions(a.admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const auditorView = await app.views.transaction(a.auditor, txId);
        expect(auditorView.documents.every((d) => !d.canOpen)).toBe(true);
        expect(auditorView.can.uploadDocuments).toBe(false);
        await expect(app.risk.review(a.auditor, 'x', { decision: 'FALSE_POSITIVE', notes: 'nope' })).rejects.toMatchObject({
            code: 'FORBIDDEN'
        });
        await expect(app.reconciliation.run(a.compliance)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        // Parties never see risk internals
        expect((await app.views.transaction(a.buyer, txId)).risk).toBeUndefined();
    });

    it('lets organisation members read their organisation’s transactions but not other organisations’', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const dealerOrg = await app.deps.uow.run(
            async (db) => (await db.organizations.findOne({ legalName: 'Autos Saint-Laurent Export inc.' }))!.id
        );
        await app.deps.uow.run(async (db) => {
            await db.organizationMembers.insert({
                id: 'm-colleague',
                organizationId: dealerOrg,
                userId: a.forwarder.userId,
                role: 'MEMBER',
                createdAt: new Date().toISOString()
            });
        });
        const view = await app.views.transaction(a.forwarder, txId);
        expect(view.viewer.viaOrganization).toBe(true);
        expect(view.can.submitMilestone).toBe(false);
        await expect(app.transactions.cancel(a.forwarder, txId, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(app.views.transaction(a.inspector, txId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('binds invitations to the invited email and makes them single-use', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { token } = await createAndInvite(app, a.seller);
        await expect(app.transactions.acceptInvitation(a.buyer2, token('BUYER'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(app.transactions.previewInvitation('not-a-real-token-but-long-enough')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
        await expect(app.transactions.acceptInvitation(a.buyer, token('BUYER'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('prevents a seller from approving their own milestone and a buyer from submitting one', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        const id = await submitMilestone(app, a.seller, txId, 0);
        await expect(app.milestones.review(a.seller, txId, id, { decision: 'APPROVE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(app.milestones.submit(a.buyer, txId, id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
});

describe('no fake funding or payout through forged / replayed partner events', () => {
    it('rejects unsigned, tampered and wrongly signed webhooks without changing state', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx, token } = await createAndInvite(app, a.seller);
        await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
        const { agree } = await import('./flow');
        await agree(app, a.seller, a.buyer, tx.id);
        const instruction = await app.payments.requestFundingInstructions(a.buyer, tx.id);
        const body = JSON.stringify({
            id: 'evt_forged',
            type: 'funds.confirmed',
            created: new Date().toISOString(),
            data: { instructionReference: instruction.providerReference, amountMinor: '1850000', currency: 'CAD' }
        });
        const now = Math.floor(Date.now() / 1000);
        await expect(app.providerEvents.ingest(body, null)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
        await expect(app.providerEvents.ingest(body, signPayload('attacker-secret', body, now))).rejects.toMatchObject({
            code: 'INVALID_SIGNATURE'
        });
        const valid = signPayload('test-webhook-secret-0123456789', body, now);
        await expect(app.providerEvents.ingest(body.replace('1850000', '1'), valid)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
        await expect(
            app.providerEvents.ingest(body, signPayload('test-webhook-secret-0123456789', body, now - 3600))
        ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
        const v = await app.views.transaction(a.buyer, tx.id);
        expect(v.status).toBe('AWAITING_FUNDING');
        expect(v.payment!.heldMinor).toBe('0');
        const audit = await app.admin.auditLog(a.auditor);
        expect(audit.events.filter((e) => e.action === 'provider_event.rejected')).toHaveLength(4);
    });

    it('processes a replayed event only once (idempotent ledger)', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        let captured: string | undefined;
        const original = app.providerEvents.ingest.bind(app.providerEvents);
        app.mockProvider.setDelivery(async (raw, header) => {
            if (raw.includes('funds.confirmed')) captured = raw;
            return original(raw, header);
        });
        const { txId } = await toInProgress(app, a.seller, a.buyer);
        expect(captured).toBeDefined();
        const result = await app.mockProvider.replay(captured!);
        expect(result).toMatchObject({ status: 'duplicate' });
        const v = await app.views.transaction(a.buyer, txId);
        expect(v.payment!.heldMinor).toBe('1850000');
        expect((await app.admin.overview(a.auditor)).trialBalance.every((t) => t.balanced)).toBe(true);
    });

    it('never confirms funding when the partner reports a different amount', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx, token } = await createAndInvite(app, a.seller);
        await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
        const { agree } = await import('./flow');
        await agree(app, a.seller, a.buyer, tx.id);
        const instruction = await app.payments.requestFundingInstructions(a.buyer, tx.id);
        await app.mockProvider.simulateFunding(instruction.providerReference, { amountMinor: 1_000_000n });
        const v = await app.views.transaction(a.compliance, tx.id);
        expect(v.status).toBe('FUNDING_PENDING');
        expect(v.payment!.heldMinor).toBe('0');
        expect(v.risk!.map((r) => r.ruleId)).toContain('FUNDING_AMOUNT_MISMATCH');
        const events = await app.admin.providerEvents(a.finance);
        expect(events.find((e) => e.type === 'funds.confirmed')).toMatchObject({ status: 'FAILED', error: 'AMOUNT_MISMATCH' });
        const rec = await app.reconciliation.run(a.finance);
        expect(rec.items).toContainEqual(expect.objectContaining({ result: 'MISSING_IN_LEDGER', providerAmountMinor: '1000000' }));
    });
});

describe('document intake controls', () => {
    it('rejects disguised files, quarantines malware test files and versions documents', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const { tx } = await createAndInvite(app, a.seller);
        const fake = {
            bytes: new Uint8Array(Buffer.from('MZ this is an executable')),
            fileName: 'facture.pdf',
            declaredMimeType: 'application/pdf'
        };
        await expect(app.documents.upload(a.seller, { transactionId: tx.id, type: 'INVOICE', title: 'x' }, fake)).rejects.toMatchObject({
            code: 'VALIDATION'
        });
        const eicar = {
            bytes: new Uint8Array(Buffer.from('%PDF-1.4 X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')),
            fileName: 'x.pdf',
            declaredMimeType: 'application/pdf'
        };
        const q = await app.documents.upload(a.seller, { transactionId: tx.id, type: 'OTHER', title: 'suspect' }, eicar);
        expect(q.status).toBe('QUARANTINED');
        await expect(app.documents.issueSignedUrl(a.seller, q.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

        const [title] = (await app.documents.listForTransaction(a.seller, tx.id)).filter((d) => d.type === 'TITLE');
        const v2 = await app.documents.upload(
            a.seller,
            { transactionId: tx.id, type: 'TITLE', title: 'Titre v2', replacesDocumentId: title!.id },
            pdf('titre-v2')
        );
        expect(v2).toMatchObject({ version: 2, logicalId: title!.logicalId });
        const versions = (await app.documents.listForTransaction(a.seller, tx.id)).filter((d) => d.logicalId === title!.logicalId);
        expect(versions.map((d) => d.status).sort()).toEqual(['PENDING_REVIEW', 'SUPERSEDED']);
        expect(v2.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(v2.storageKey.startsWith(`${tx.id}/`)).toBe(true);
    });
});
