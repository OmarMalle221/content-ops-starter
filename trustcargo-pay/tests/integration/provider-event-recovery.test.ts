/**
 * A partner event whose processing never completed is not lost (both adapters; Postgres with
 * scripts/test-integration-pg.sh): a redelivery or a finance reprocess applies it, exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from '@/server/app';
import { AppError } from '@/server/errors';
import type { Db } from '@/server/ports/db';
import { RECEIVED_GRACE_MS } from '@/server/services/provider-event-service';
import { actors, createTestApp } from './helpers';
import { agree, createAndInvite } from './flow';

async function fundingRequested(app: App) {
    const a = await actors(app);
    const { tx, token } = await createAndInvite(app, a.seller);
    await app.transactions.acceptInvitation(a.buyer, token('BUYER'));
    await agree(app, a.seller, a.buyer, tx.id);
    const instruction = await app.payments.requestFundingInstructions(a.buyer, tx.id);
    return { a, txId: tx.id, instruction };
}

/**
 * While the partner delivers funds.confirmed, the units of work after the first one (which records the event
 * as RECEIVED) fail as on a busy database: `failing` of them, or all with Infinity. Returns the raw delivery.
 */
function failFundsConfirmedProcessing(app: App, failing: number) {
    const uow = app.deps.uow;
    const run = uow.run.bind(uow);
    let active = false;
    let calls = 0;
    vi.spyOn(uow, 'run').mockImplementation(((fn: (db: Db) => Promise<unknown>) => {
        if (active && calls++ >= 1 && calls <= failing + 1) return Promise.reject(new AppError('UNAVAILABLE', 'Simulated busy database'));
        return run(fn);
    }) as typeof uow.run);
    const deliver = app.providerEvents.ingest.bind(app.providerEvents);
    const captured: { raw?: string } = {};
    app.mockProvider.setDelivery(async (raw, header) => {
        if (!raw.includes('"funds.confirmed"')) return deliver(raw, header);
        captured.raw = raw;
        [active, calls] = [true, 0];
        try {
            return await deliver(raw, header);
        } finally {
            active = false;
        }
    });
    return captured;
}

const fundsEvent = async (app: App, finance: Parameters<App['admin']['providerEvents']>[0]) =>
    (await app.admin.providerEvents(finance)).find((e) => e.type === 'funds.confirmed')!;

describe('partner events whose processing never completed', () => {
    it('processes a redelivered event left RECEIVED once the grace period is over, and only once', async () => {
        const app = await createTestApp();
        const { a, txId, instruction } = await fundingRequested(app);
        const delivery = failFundsConfirmedProcessing(app, Infinity);
        // Processing and the FAILED marking both fail: the event stays RECEIVED, the partner gets a 503.
        await expect(app.mockProvider.simulateFunding(instruction.providerReference)).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            status: 503
        });
        vi.mocked(app.deps.uow.run).mockRestore();
        const stuck = await fundsEvent(app, a.finance);
        expect(stuck.status).toBe('RECEIVED');
        expect((await app.views.transaction(a.buyer, txId)).payment!.heldMinor).toBe('0');

        // Within the grace period its first processing may still be running elsewhere: retry later.
        expect(app.providerEvents.reprocessable(stuck)).toBe(false);
        await expect(app.mockProvider.replay(delivery.raw!)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect(app.providerEvents.reprocess(a.finance, stuck.id)).rejects.toMatchObject({ code: 'CONFLICT' });

        app.clock.advance(RECEIVED_GRACE_MS + 1_000);
        expect(app.providerEvents.reprocessable(stuck)).toBe(true);
        expect(await app.mockProvider.replay(delivery.raw!)).toMatchObject({ status: 'processed', eventId: stuck.id });
        expect(await fundsEvent(app, a.finance)).toMatchObject({ status: 'PROCESSED' });
        expect(await app.mockProvider.replay(delivery.raw!)).toMatchObject({ status: 'duplicate' });
        const view = await app.views.transaction(a.buyer, txId);
        expect(view.status).toBe('IN_PROGRESS');
        expect(view.payment!.heldMinor).toBe('1850000');
        const audit = await app.admin.auditLog(a.auditor);
        expect(audit.events.filter((e) => e.action === 'provider_event.redelivered')).toHaveLength(1);
    });

    it('lets finance reprocess an event left RECEIVED past the grace period', async () => {
        const app = await createTestApp();
        const { a, txId, instruction } = await fundingRequested(app);
        failFundsConfirmedProcessing(app, Infinity);
        await expect(app.mockProvider.simulateFunding(instruction.providerReference)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        vi.mocked(app.deps.uow.run).mockRestore();
        const stuck = await fundsEvent(app, a.finance);
        app.clock.advance(RECEIVED_GRACE_MS + 1_000);
        expect(await app.providerEvents.reprocess(a.finance, stuck.id)).toMatchObject({ status: 'processed' });
        expect((await app.views.transaction(a.buyer, txId)).payment!.heldMinor).toBe('1850000');
        await expect(app.providerEvents.reprocess(a.finance, stuck.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('applies a FAILED event once when it is reprocessed twice at the same time', async () => {
        const app = await createTestApp();
        const { a, txId, instruction } = await fundingRequested(app);
        failFundsConfirmedProcessing(app, 1); // processing fails, the FAILED marking succeeds
        await app.mockProvider.simulateFunding(instruction.providerReference);
        vi.mocked(app.deps.uow.run).mockRestore();
        const failed = await fundsEvent(app, a.finance);
        expect(failed.status).toBe('FAILED');

        const results = await Promise.allSettled([
            app.providerEvents.reprocess(a.finance, failed.id),
            app.providerEvents.reprocess(a.finance, failed.id)
        ]);
        const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value.status : (r.reason as AppError).code)).sort();
        expect(outcomes[1]).toBe('processed');
        expect(['CONFLICT', 'duplicate']).toContain(outcomes[0]);
        expect(await fundsEvent(app, a.finance)).toMatchObject({ status: 'PROCESSED' });
        expect((await app.views.transaction(a.buyer, txId)).payment!.heldMinor).toBe('1850000');
        expect((await app.admin.overview(a.auditor)).trialBalance.every((t) => t.balanced)).toBe(true);
    });
});
