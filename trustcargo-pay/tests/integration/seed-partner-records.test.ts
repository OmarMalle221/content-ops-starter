/**
 * The first-boot demo seed and the SIMULATED partner's records (src/server/demo/seed.ts). In memory by default;
 * with TEST_PG_ADMIN_URL (scripts/test-integration-pg.sh) both instances share one migrated Postgres database,
 * so the partner's records live in schema trustcargo_sim, outside the seed's transaction.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { money } from '@/domain/money';
import { createApp, type App } from '@/server/app';
import { loadConfig } from '@/server/config';
import { personaActor } from '@/server/demo/seed';
import { seedIfEmpty } from '@/server/instance';
import { createTestDatabase, usePostgres } from './pg-test-db';

const ENV = {
    TRUSTCARGO_MODE: 'demo',
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    APP_URL: 'http://localhost:3000'
};
const ALL = { from: '1970-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };

/** A first instance, and a restart: a new instance on the same database (Postgres), or the same one (memory). */
async function deployment(): Promise<{ first: App; restart: () => App }> {
    const apps: App[] = [];
    const database = usePostgres ? await createTestDatabase() : undefined;
    onTestFinished(async () => {
        for (const app of apps) await app.persistence.close();
        await database?.drop();
    });
    const instance = () => {
        const persistence = database ? { DATABASE_URL: database.url, STORAGE_PROVIDER: 'memory', DATABASE_POOL_MAX: '2' } : {};
        const app = createApp(loadConfig({ ...ENV, ...persistence } as unknown as NodeJS.ProcessEnv));
        apps.push(app);
        return app;
    };
    const first = instance();
    return { first, restart: () => (database ? instance() : first) };
}

describe(`first-boot seed and the simulated partner (${usePostgres ? 'Postgres' : 'memory'})`, () => {
    it('leaves no partner records behind when it rolls back, and never drives a partner record it did not create', async () => {
        const { first, restart } = await deployment();
        // Crash right after the partner accepted the first payout: funds received and a transfer SUBMITTED at the partner.
        vi.spyOn(first.mockProvider, 'simulateTransferOutcome').mockRejectedValueOnce(new Error('simulated crash'));
        await expect(seedIfEmpty(first)).rejects.toThrow('simulated crash');
        expect(await first.mockProvider.pendingTransfers()).toEqual([]);
        expect(await first.mockProvider.reconcileTransactions(ALL)).toEqual([]);

        // A transfer left at the partner by something else (e.g. a seed of an older version): left untouched.
        const leftover = await first.mockProvider.requestAuthorizedRelease({
            payoutId: 'leftover',
            transactionId: 'leftover',
            amount: money(100_000n, 'CAD'),
            payeeAccountToken: 'sim_vault_leftover',
            idempotencyKey: 'payout:leftover',
            authorizationReference: 'leftover'
        });

        const app = restart();
        expect(await seedIfEmpty(app)).toBe(true);
        const finance = await personaActor(app, 'finance');
        const statuses = (await app.transactions.listForActor(await personaActor(app, 'seller'))).map((x) => x.transaction.status);
        expect(statuses.sort()).toEqual(['AWAITING_FUNDING', 'AWAITING_PARTIES', 'COMPLETED', 'DISPUTED', 'MILESTONE_REVIEW']);
        expect((await app.admin.providerEvents(finance)).filter((e) => e.status === 'FAILED')).toEqual([]);
        expect(await app.deps.uow.run((db) => db.notifications.findBy({ type: 'provider_event.failed' }))).toEqual([]);
        const transfers = await app.mockProvider.pendingTransfers();
        expect(transfers.find((t) => t.reference === leftover.providerReference)).toMatchObject({ status: 'SUBMITTED' });
        expect(transfers.filter((t) => t.reference !== leftover.providerReference).every((t) => t.status === 'PAID')).toBe(true);
        expect((await app.reconciliation.run(finance)).status).toBe('MATCHED');
    });
});
