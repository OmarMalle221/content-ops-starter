/** Simulated KYC sessions, on both persistence adapters (Postgres with scripts/test-integration-pg.sh). */
import { describe, expect, it } from 'vitest';
import { actors, createTestApp } from './helpers';

describe('identity verification (simulated)', () => {
    it('continues the open session when verification is started twice (double submit, stale tab)', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const concurrent = await Promise.all([app.identity.start(a.buyer2), app.identity.start(a.buyer2)]);
        const first = concurrent[0]!;
        expect(concurrent[1]!.id).toBe(first.id);
        expect((await app.identity.start(a.buyer2)).id).toBe(first.id);
        const sessions = await app.deps.uow.run((db) => db.identityVerifications.findBy({ subjectId: a.buyer2.userId }));
        expect(sessions.map((v) => v.status)).toEqual(['PENDING']);

        expect((await app.identity.complete(a.buyer2, first.id, 'APPROVE')).status).toBe('VERIFIED');
        await expect(app.identity.start(a.buyer2)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('screens the user again on a later verification, under a new screening reference', async () => {
        const app = await createTestApp();
        const a = await actors(app);
        const first = await app.identity.start(a.buyer2);
        await app.identity.complete(a.buyer2, first.id, 'APPROVE');
        // The verification lapses (e.g. the ID document expired): the user verifies again.
        await app.deps.uow.run((db) => db.users.update(a.buyer2.userId, { kycStatus: 'EXPIRED' }));
        const second = await app.identity.start(a.buyer2);
        expect(second.id).not.toBe(first.id);
        expect((await app.identity.complete(a.buyer2, second.id, 'APPROVE')).status).toBe('VERIFIED');

        const screenings = await app.deps.uow.run((db) => db.screeningResults.findBy({ subjectId: a.buyer2.userId }));
        expect(screenings).toHaveLength(2);
        expect(new Set(screenings.map((s) => s.providerReference)).size).toBe(2);
        expect((await app.deps.uow.run((db) => db.users.get(a.buyer2.userId)))!.kycStatus).toBe('VERIFIED');
    });
});
