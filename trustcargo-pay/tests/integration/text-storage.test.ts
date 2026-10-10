/**
 * User text is stored identically by both persistence adapters (in memory, and on Postgres with
 * scripts/test-integration-pg.sh): cut on code points, lone surrogates stored as U+FFFD, U+0000 refused.
 */
import { describe, expect, it } from 'vitest';
import { actors, createTestApp } from './helpers';
import { createAndInvite } from './flow';

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
        // A filter value that can never be stored as is matches nothing (and is not a database error).
        expect(await app.deps.uow.run((db) => db.notifications.findBy({ type: 'note\uDC00' }))).toEqual([]);
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
});
