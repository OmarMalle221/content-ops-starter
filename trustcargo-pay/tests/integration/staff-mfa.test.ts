import { describe, expect, it } from 'vitest';
import type { Document, PlatformRole } from '@/domain/model';
import type { Actor } from '@/server/auth/actor';
import { signDocumentUrl } from '@/server/security/signed-url';
import { requireStaffRole } from '@/server/services/context';
import { actors, createTestApp, withoutMfa } from './helpers';
import { pdf, toInProgress } from './flow';

/** What getActor() returns for a staff session without a recent MFA: the roles are held, none is effective. */
const pending = (actor: Actor): Actor => ({ ...withoutMfa(actor), platformRoles: [], pendingPlatformRoles: actor.platformRoles });

async function setup() {
    const app = await createTestApp();
    const a = await actors(app);
    const { txId } = await toInProgress(app, a.seller, a.buyer);
    const docs = await app.documents.listForTransaction(a.seller, txId);
    const invoice = docs.find((d) => d.type === 'INVOICE')!;
    // An identity document attached to the transaction (KYC documents only ever come from the provider in the app),
    // never shared with counterparties.
    const id = app.deps.ids.id();
    const identity: Document = {
        ...invoice,
        id,
        logicalId: app.deps.ids.id(),
        type: 'IDENTITY',
        ownerUserId: a.buyer.userId,
        visibleToRoles: [],
        storageKey: `${txId}/${id}/${invoice.sha256}`
    };
    await app.deps.uow.run((db) => db.documents.insert(identity));
    return { app, a, txId, invoice, identity };
}

describe('staff access requires a recent MFA in the services, not only on /admin pages', () => {
    it('gives a staff actor without MFA no transaction, document or file, while the same actor with MFA gets them', async () => {
        const { app, a, txId, invoice, identity } = await setup();
        for (const staff of [a.compliance, a.disputes, a.reviewer, a.auditor, a.finance]) {
            await expect(app.views.transaction(withoutMfa(staff), txId)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
            await expect(app.documents.listForTransaction(withoutMfa(staff), txId)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
            await expect(app.documents.comparison(withoutMfa(staff), txId)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
            // A session whose roles are pending (getActor) has no staff visibility at all: 404, no existence oracle.
            await expect(app.views.transaction(pending(staff), txId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(app.views.transaction(staff, txId)).resolves.toMatchObject({ id: txId });
        }

        const canView = (actor: Actor, doc: Document) => app.deps.uow.run((db) => app.documents.canView(db, actor, doc));
        for (const staff of [a.compliance, a.disputes, a.reviewer]) {
            expect(await canView(staff, invoice)).toBe(true);
            expect(await canView(withoutMfa(staff), invoice)).toBe(false);
            await expect(app.documents.issueSignedUrl(withoutMfa(staff), invoice.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
            // Even with a valid signature for that user, the content is refused (fresh authorisation on download).
            const exp = String(Math.floor(app.clock.now().getTime() / 1000) + 60);
            const url = new URL(signDocumentUrl(app.deps.config.sessionSecret, invoice.id, staff.userId, Number(exp)), 'http://x');
            await expect(
                app.documents.readContent(withoutMfa(staff), invoice.id, url.searchParams.get('exp'), url.searchParams.get('sig'))
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                app.documents.readContent(staff, invoice.id, url.searchParams.get('exp'), url.searchParams.get('sig'))
            ).resolves.toMatchObject({ mimeType: 'application/pdf' });
        }
        expect(await canView(a.compliance, identity)).toBe(true);
        expect(await canView(withoutMfa(a.compliance), identity)).toBe(false);
        expect(await canView(pending(a.compliance), identity)).toBe(false);
        const denied = await app.deps.uow.run((db) => db.documentAccessLogs.findBy({ documentId: invoice.id, action: 'DENIED' }));
        expect(denied.length).toBeGreaterThanOrEqual(6);
    });

    it('keeps party access without MFA, and grants staff-only extras (auditor listing) only with a recent MFA', async () => {
        const { app, a, txId, identity } = await setup();
        // The seller's identity document, which no other party sees.
        const sellerId = app.deps.ids.id();
        const sellerIdentity: Document = {
            ...identity,
            id: sellerId,
            logicalId: app.deps.ids.id(),
            ownerUserId: a.seller.userId,
            storageKey: `${txId}/${sellerId}/${identity.sha256}`
        };
        await app.deps.uow.run((db) => db.documents.insert(sellerIdentity));
        // A JOINED buyer who also holds the auditor role: party access as usual, the auditor listing only after MFA.
        const buyerAuditor: Actor = { ...withoutMfa(a.buyer), platformRoles: ['auditor'] };
        const asParty = await app.documents.listForTransaction(buyerAuditor, txId);
        expect(asParty.map((d) => d.id)).toContain(identity.id);
        expect(asParty.map((d) => d.id)).not.toContain(sellerIdentity.id);
        await expect(app.views.transaction(buyerAuditor, txId)).resolves.toMatchObject({ id: txId });
        const withMfa = await app.documents.listForTransaction({ ...a.buyer, platformRoles: ['auditor'] }, txId);
        expect(withMfa.map((d) => d.id)).toContain(sellerIdentity.id);
        // The buyer's own identity document stays theirs, MFA or not.
        expect(await app.deps.uow.run((db) => app.documents.canView(db, withoutMfa(a.buyer), identity))).toBe(true);
        await expect(
            app.documents.upload(withoutMfa(a.seller), { transactionId: txId, type: 'PHOTO', title: 'p' }, pdf('p'))
        ).resolves.toMatchObject({ type: 'PHOTO' });
    });

    it('refuses every staff-only operation to a staff actor without a recent MFA (MFA_REQUIRED), and to others (FORBIDDEN)', async () => {
        const { app, a, txId, invoice } = await setup();
        const alert = (await app.risk.listAlerts(a.compliance, { transactionId: txId }))[0];
        const stale = (actor: Actor): Actor => ({
            ...actor,
            mfaVerifiedAt: new Date(app.clock.now().getTime() - 13 * 3_600_000).toISOString()
        });
        const cases: [string, (actor: Actor) => Promise<unknown>, Actor][] = [
            [
                'risk.review',
                (x) => app.risk.review(x, alert?.alert.id ?? 'none', { decision: 'FALSE_POSITIVE', notes: 'faux positif vérifié' }),
                a.compliance
            ],
            ['risk.listAlerts', (x) => app.risk.listAlerts(x), a.compliance],
            ['identity.review', (x) => app.identity.review(x, 'none', 'VERIFIED', 'pièce vérifiée'), a.compliance],
            ['identity.listPending', (x) => app.identity.listPending(x), a.compliance],
            ['documents.review', (x) => app.documents.review(x, invoice.id, { decision: 'VERIFIED', notes: 'ok' }), a.reviewer],
            ['documents.accessLog', (x) => app.documents.accessLog(x, invoice.id), a.reviewer],
            [
                'compliance.placeHold',
                (x) => app.compliance.placeHold(x, txId, { type: 'LEGAL', reference: 'R-1', notes: 'gel' }),
                a.compliance
            ],
            ['compliance.liftHold', (x) => app.compliance.liftHold(x, 'none', 'levée justifiée'), a.compliance],
            ['compliance.list', (x) => app.compliance.list(x), a.compliance],
            ['reconciliation.run', (x) => app.reconciliation.run(x), a.finance],
            ['reconciliation.list', (x) => app.reconciliation.list(x), a.finance],
            ['disputes.assign', (x) => app.disputes.assign(x, 'none'), a.disputes],
            ['disputes.decide', (x) => app.disputes.decide(x, 'none', {}), a.disputes],
            ['disputes.archive', (x) => app.disputes.archive(x, 'none'), a.disputes],
            ['disputes.listAll', (x) => app.disputes.listAll(x), a.disputes],
            ['providerEvents.reprocess', (x) => app.providerEvents.reprocess(x, 'none'), a.finance],
            ['payments.retryBlockedReleases', (x) => app.payments.retryBlockedReleases(x, txId), a.finance],
            ['admin.overview', (x) => app.admin.overview(x), a.auditor],
            ['admin.listTransactions', (x) => app.admin.listTransactions(x), a.auditor],
            ['admin.listDocumentsToReview', (x) => app.admin.listDocumentsToReview(x), a.reviewer],
            ['admin.listOrganizations', (x) => app.admin.listOrganizations(x), a.auditor],
            ['admin.listUsers', (x) => app.admin.listUsers(x), a.admin],
            ['admin.providerEvents', (x) => app.admin.providerEvents(x), a.finance],
            ['admin.providerConnections', (x) => app.admin.providerConnections(x), a.finance],
            ['admin.ledgerView', (x) => app.admin.ledgerView(x), a.finance],
            ['admin.auditLog', (x) => app.admin.auditLog(x), a.auditor],
            ['admin.securitySettings', (x) => app.admin.securitySettings(x), a.admin],
            ['admin.updateCorridor', (x) => app.admin.updateCorridor(x, 'none', {}), a.admin],
            ['admin.updateSecuritySettings', (x) => app.admin.updateSecuritySettings(x, {}), a.admin]
        ];
        for (const [name, run, staff] of cases) {
            for (const actor of [withoutMfa(staff), pending(staff), stale(staff)]) {
                await expect(
                    run(actor).then(() => name),
                    name
                ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
            }
            await expect(
                run(a.buyer).then(() => name),
                name
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
        // Positive controls: the same operations with a recent MFA.
        await expect(app.admin.overview(a.auditor)).resolves.toMatchObject({ transactions: 1 });
        await expect(app.reconciliation.list(a.finance)).resolves.toEqual([]);
    });

    it('is the check the back-office actions use for services that only check the role (partner event reprocess…)', async () => {
        const { app, a } = await setup();
        const finance: PlatformRole[] = ['finance_operator'];
        await expect(requireStaffRole(app.deps, withoutMfa(a.finance), finance)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        await expect(requireStaffRole(app.deps, pending(a.finance), finance)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        await expect(requireStaffRole(app.deps, a.buyer, finance)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(requireStaffRole(app.deps, a.finance, finance)).resolves.toBeUndefined();
    });
});
