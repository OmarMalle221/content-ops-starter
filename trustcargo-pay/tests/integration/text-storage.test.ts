/**
 * User text is stored identically by both persistence adapters (in memory, and on Postgres with
 * scripts/test-integration-pg.sh): cut on code points, lone surrogates stored as U+FFFD, U+0000 refused,
 * and a text filter compared in its stored form.
 */
import { describe, expect, it } from 'vitest';
import type { Reconciliation } from '@/domain/model';
import { hashCanonical } from '@/server/security/crypto';
import { actors, createTestApp } from './helpers';
import { agree, createAndInvite, input } from './flow';

const CAR = '\u{1F697}';

async function cancelledWith(reason: string) {
    const app = await createTestApp();
    const a = await actors(app);
    const { tx } = await createAndInvite(app, a.seller);
    const result = await app.transactions.cancel(a.seller, tx.id, reason).then(
        (updated) => ({ ok: true as const, status: updated.status }),
        (error: { code?: string }) => ({ ok: false as const, code: error.code })
    );
    const stored = await app.deps.uow.run((db) => db.transactions.get(tx.id));
    const audit = await app.admin.auditLog(a.auditor, { transactionId: tx.id });
    return { app, a, result, stored: stored!, audit };
}

describe('user text storage (same rule on every adapter)', () => {
    it('cancels with a reason longer than 500 characters whose cut falls inside an emoji', async () => {
        const { result, stored, audit } = await cancelledWith('x'.repeat(499) + CAR + 'tail');
        expect(result).toEqual({ ok: true, status: 'CANCELLED' });
        expect(stored.cancellationReason).toBe('x'.repeat(499) + CAR);
        expect(audit.events.find((e) => e.action === 'transaction.cancelled')?.metadata).toMatchObject({ reason: 'x'.repeat(499) + CAR });
        expect(audit.chain.valid).toBe(true);
    });

    it('stores a lone surrogate as U+FFFD, in columns and audit metadata, and the audit chain stays valid', async () => {
        const { result, stored, audit } = await cancelledWith('lone \uD83D surrogate');
        expect(result).toEqual({ ok: true, status: 'CANCELLED' });
        expect(stored.cancellationReason).toBe('lone � surrogate');
        expect(audit.events.find((e) => e.action === 'transaction.cancelled')?.metadata).toMatchObject({ reason: 'lone � surrogate' });
        expect(audit.chain.valid).toBe(true);
    });

    it('refuses U+0000 with a VALIDATION error and changes nothing', async () => {
        const { result, stored } = await cancelledWith('bad\u0000reason');
        expect(result).toEqual({ ok: false, code: 'VALIDATION' });
        expect(stored.status).toBe('AWAITING_PARTIES');
        expect(stored.cancellationReason).toBeUndefined();
    });

    it('applies the rule at the adapter boundary: text columns and JSON documents (keys included)', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const id = app.deps.ids.id();
        await app.deps.uow.run((db) =>
            db.notifications.insert({
                id,
                userId: a.buyer.userId,
                type: 'note\uDC00',
                params: { ['k\uD800']: 'v\uD83D', ok: `fine ${CAR}` },
                createdAt: app.deps.clock.now().toISOString()
            })
        );
        expect(await app.deps.uow.run((db) => db.notifications.get(id))).toMatchObject({
            type: 'note�',
            params: { ['k�']: 'v�', ok: `fine ${CAR}` }
        });
        // A filter value is compared in its stored form: the value inserted finds its row again...
        for (const type of ['note\uDC00', 'note\uD800', 'note\uFFFD'])
            expect((await app.deps.uow.run((db) => db.notifications.findBy({ type }))).map((n) => n.id)).toEqual([id]);
        // ...and a value that can never be stored (U+0000) matches nothing, without a database error.
        expect(await app.deps.uow.run((db) => db.users.findBy({ email: 'a\u0000b@example.test' }))).toEqual([]);
        await expect(
            app.deps.uow.run((db) =>
                db.notifications.insert({
                    id: app.deps.ids.id(),
                    userId: a.buyer.userId,
                    type: 'x',
                    params: { nul: 'a\u0000b' },
                    createdAt: app.deps.clock.now().toISOString()
                })
            )
        ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('stores reconciliation items and filters the demo TOTP secret with the same rule (related tables)', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const reconciliation = (externalReference: string): Reconciliation => ({
            id: app.deps.ids.id(),
            provider: 'mock',
            runBy: a.finance.userId,
            runAt: app.deps.clock.now().toISOString(),
            status: 'DISCREPANCIES',
            items: [{ externalReference, kind: 'FUNDS_RECEIVED', providerAmountMinor: '100', currency: 'CAD', result: 'MISSING_IN_LEDGER' }]
        });
        const stored = reconciliation('ref\uD800');
        await app.deps.uow.run((db) => db.reconciliations.insert(stored));
        const [read] = await app.deps.uow.run(async (db) => (await db.reconciliations.list()).filter((r) => r.id === stored.id));
        expect(read!.items).toEqual([{ ...stored.items[0], externalReference: 'ref\uFFFD' }]);
        await expect(app.deps.uow.run((db) => db.reconciliations.insert(reconciliation('ref\u0000x')))).rejects.toMatchObject({
            code: 'VALIDATION'
        });
        expect(await app.deps.uow.run(async (db) => (await db.reconciliations.list()).length)).toBe(1);

        const finance = (await app.deps.uow.run((db) => db.users.get(a.finance.userId)))!;
        expect(finance.mfaTotpSecret).toBeDefined();
        const holders = await app.deps.uow.run((db) => db.users.findBy({ mfaTotpSecret: finance.mfaTotpSecret }));
        expect(holders.map((u) => u.id)).toContain(finance.id);
        expect(await app.deps.uow.run((db) => db.users.findBy({ mfaTotpSecret: 'a\u0000b' }))).toEqual([]);
    });

    it('deduplicates a redelivered partner event whose id holds a lone surrogate (one stored event)', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const body = (id: string, type: string, data: Record<string, string> = {}) =>
            JSON.stringify({ id, type, created: app.clock.now().toISOString(), livemode: false, data });
        const ignored = body('evt_\uD800dup', 'provider.error');
        expect(await app.mockProvider.replay(ignored)).toMatchObject({ status: 'processed' });
        expect(await app.mockProvider.replay(ignored)).toMatchObject({ status: 'duplicate' });
        // A FAILED one is applied again on redelivery (still failing here), never inserted twice.
        const failing = body('evt_\uDC00fail', 'payment.initiated', { instructionReference: 'sim_pi_unknown' });
        const first = await app.mockProvider.replay(failing);
        expect(first).toMatchObject({ status: 'failed' });
        expect(await app.mockProvider.replay(failing)).toEqual(first);
        const events = await app.admin.providerEvents(a.finance);
        expect(events.map((e) => [e.externalEventId, e.status]).sort()).toEqual([
            ['evt_\uFFFDdup', 'IGNORED'],
            ['evt_\uFFFDfail', 'FAILED']
        ]);
    });

    it('fingerprints the contract terms as stored, so acceptances bind to them and an unchanged amendment is refused', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const terms = { ...input().terms, goodsDescription: 'Toyota RAV4 \uD83D 2021' };
        const { tx, token } = await createAndInvite(app, a.seller, { terms });
        const version = await app.deps.uow.run(async (db) => (await db.contractVersions.findBy({ transactionId: tx.id }))[0]!);
        expect(version.terms.goodsDescription).toBe('Toyota RAV4 \uFFFD 2021');
        expect(version.contentHash).toBe(hashCanonical(version.terms));

        await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
        expect((await agree(app, a.seller, a.buyer, tx.id)).status).toBe('AWAITING_FUNDING');
        const view = await app.views.transaction(a.seller, tx.id);
        expect(view.contract!.contentHash).toBe(hashCanonical(view.contract!.terms));
        // Re-submitting what the edit form shows (the stored terms), or the original input, is no change.
        for (const goodsDescription of [view.contract!.terms.goodsDescription, terms.goodsDescription])
            await expect(
                app.transactions.amendContract(a.seller, tx.id, {
                    price: { amount: '18500', currency: 'CAD' },
                    terms: { ...view.contract!.terms, goodsDescription },
                    milestones: view.contract!.terms.milestones,
                    changeSummary: 'Aucun changement'
                })
            ).rejects.toMatchObject({ code: 'VALIDATION', message: 'No change compared with the current version' });
        expect((await app.views.transaction(a.seller, tx.id)).contract!.versionNumber).toBe(1);
    });
});
