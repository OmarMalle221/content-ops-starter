/**
 * Records of the SIMULATED payment partner (MockPaymentProvider) — SIMULATION ONLY, no real funds.
 *
 * The same store contract runs on the in-memory store and, with TEST_PG_ADMIN_URL
 * (scripts/test-integration-pg.sh), on the Postgres store (schema trustcargo_sim). The Postgres-only cases
 * check what memory cannot show: the partner's records survive a restart and are shared by instances, and
 * the partner's writes are never part of TrustCargo's unit of work.
 */
import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import { money } from '@/domain/money';
import { MemorySimulatedPartnerStore, type SimulatedPartnerStore } from '@/server/adapters/mock/simulated-partner-store';
import { PostgresSimulatedPartnerStore } from '@/server/adapters/postgres/pg-simulated-partner-store';
import { createApp } from '@/server/app';
import { loadConfig } from '@/server/config';
import { seedReferenceData } from '@/server/demo/seed';
import { isProviderError, type StatementLine } from '@/server/ports/payment-provider';
import { agree, createAndInvite, payAllSubmitted, submitMilestone } from './flow';
import { actors } from './helpers';
import { captureProcessErrors, createTestDatabase, usePostgres, waitFor } from './pg-test-db';

const ALL = { from: '1970-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };
const at = (second: number, ms = 0) => new Date(Date.UTC(2026, 0, 10, 14, 0, second, ms)).toISOString();
const line = (externalReference: string, occurredAt: string, amountMinor = '1850000'): StatementLine => ({
    externalReference,
    kind: 'FUNDS_RECEIVED',
    amountMinor,
    currency: 'CAD',
    occurredAt
});
const partnerError = (retryable: boolean) => (e: unknown) => isProviderError(e) && e.retryable === retryable;

const env = (url?: string) =>
    loadConfig({
        TRUSTCARGO_MODE: 'demo',
        SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
        ...(url ? { DATABASE_URL: url, DATABASE_ROLE: 'service_role', STORAGE_PROVIDER: 'memory', DATABASE_POOL_MAX: '2' } : {})
    } as unknown as NodeJS.ProcessEnv);

async function openPostgresStore(): Promise<SimulatedPartnerStore> {
    const database = await createTestDatabase();
    const store = new PostgresSimulatedPartnerStore({ url: database.url, role: 'service_role', poolMax: 2 });
    onTestFinished(async () => {
        await store.close();
        await database.drop();
    });
    return store;
}

function contract(name: string, enabled: boolean, open: () => Promise<SimulatedPartnerStore>) {
    describe.skipIf(!enabled)(`simulated partner store (${name})`, () => {
        it('issues one instruction per idempotency key and returns the stored one, unchanged, for a known key', async () => {
            const store = await open();
            const first = {
                reference: 'sim_pi_first',
                idempotencyKey: 'fund:a',
                amount: money(1_850_000n, 'CAD'),
                status: 'CREATED' as const
            };
            expect(await store.createInstruction(first)).toEqual(first);
            const replay = await store.createInstruction({ ...first, reference: 'sim_pi_other', amount: money(1n, 'XOF') });
            expect(replay).toEqual(first);
            expect(await store.getInstruction('sim_pi_other')).toBeUndefined();
            const second = await store.createInstruction({ ...first, reference: 'sim_pi_second', idempotencyKey: 'fund:b' });
            expect(second.reference).toBe('sim_pi_second');
            expect(await store.getInstruction('sim_pi_first')).toEqual(first);
        });

        it('moves instruction statuses and appends the statement line atomically; unknown references are partner errors', async () => {
            const store = await open();
            await store.createInstruction({
                reference: 'sim_pi_x',
                idempotencyKey: 'fund:x',
                amount: money(1_850_000n, 'CAD'),
                status: 'CREATED'
            });
            await store.setInstructionStatus('sim_pi_x', 'PENDING');
            expect((await store.getInstruction('sim_pi_x'))!.status).toBe('PENDING');
            expect(await store.statement(ALL)).toEqual([]);
            await store.setInstructionStatus('sim_pi_x', 'FUNDED', line('sim_pi_x', at(1)));
            expect((await store.getInstruction('sim_pi_x'))!.status).toBe('FUNDED');
            expect(await store.statement(ALL)).toEqual([line('sim_pi_x', at(1))]);

            await expect(store.setInstructionStatus('sim_pi_unknown', 'FUNDED', line('sim_pi_unknown', at(2)))).rejects.toSatisfy(
                partnerError(false)
            );
            expect(await store.statement(ALL)).toEqual([line('sim_pi_x', at(1))]);
            expect(await store.getInstruction('sim_pi_unknown')).toBeUndefined();
        });

        it('keeps transfers idempotent per key and lists them in creation order with their status', async () => {
            const store = await open();
            const refund = {
                reference: 'sim_rf_z',
                kind: 'REFUND' as const,
                idempotencyKey: 'refund:1',
                amount: money(500_000n, 'CAD'),
                status: 'SUBMITTED' as const
            };
            const payout = { ...refund, reference: 'sim_po_a', kind: 'PAYOUT' as const, idempotencyKey: 'payout:1' };
            expect(await store.createTransfer(refund)).toEqual(refund);
            expect(await store.createTransfer(payout)).toEqual(payout);
            expect(await store.createTransfer({ ...payout, reference: 'sim_po_dup', amount: money(1n, 'CAD') })).toEqual(payout);
            await store.setTransferStatus('sim_po_a', 'PAID', { ...line('sim_po_a', at(3), '500000'), kind: 'PAYOUT_PAID' });
            await store.setTransferStatus('sim_rf_z', 'FAILED');
            expect(await store.listTransfers()).toEqual([
                { ...refund, status: 'FAILED' },
                { ...payout, status: 'PAID' }
            ]);
            expect((await store.getTransfer('sim_po_a'))!.status).toBe('PAID');
            expect(await store.getTransfer('sim_po_dup')).toBeUndefined();
            expect(await store.statement(ALL)).toEqual([{ ...line('sim_po_a', at(3), '500000'), kind: 'PAYOUT_PAID' }]);
            await expect(store.setTransferStatus('sim_po_unknown', 'PAID')).rejects.toSatisfy(partnerError(false));
        });

        it('returns statement lines of a range (bounds included) in recording order, with exact amounts, as copies', async () => {
            const store = await open();
            const lines = [
                line('sim_pi_1', at(1, 123)),
                line('sim_pi_2', at(3, 456), '9007199254740993'),
                line('sim_pi_3', at(2)),
                line('sim_unknown_1', at(4))
            ];
            for (const l of lines) await store.appendStatementLine(l);
            expect(await store.statement(ALL)).toEqual(lines);
            expect(await store.statement({ from: at(2), to: at(3, 456) })).toEqual([lines[1], lines[2]]);
            expect(await store.statement({ from: at(5), to: at(6) })).toEqual([]);
            const read = await store.statement(ALL);
            read[0]!.amountMinor = '1';
            expect(await store.statement(ALL)).toEqual(lines);
        });
    });
}

contract('memory', true, async () => new MemorySimulatedPartnerStore());
contract('postgres', usePostgres, openPostgresStore);

describe('simulated partner wiring', () => {
    it('keeps the partner in memory without DATABASE_URL', async () => {
        const app = createApp(env());
        expect(app.persistence.kind).toBe('memory');
        expect(app.persistence.simulatedPartner).toBeInstanceOf(MemorySimulatedPartnerStore);
    });
});

describe.skipIf(!usePostgres)('simulated partner on Postgres (trustcargo_sim)', () => {
    /** A fresh migrated database; what `track` registers is closed (last first) before the database is dropped. */
    async function database() {
        const db = await createTestDatabase();
        const closers: (() => Promise<unknown>)[] = [];
        onTestFinished(async () => {
            for (const close of closers.reverse()) await close();
            await db.drop();
        });
        return { url: db.url, track: (close: () => Promise<unknown>) => void closers.push(close) };
    }

    it('survives a restart: a new process funds and settles what the previous one issued, and reconciliation matches', async () => {
        const { url, track } = await database();
        const first = createApp(env(url));
        track(() => first.persistence.close());
        expect(first.persistence.simulatedPartner).toBeInstanceOf(PostgresSimulatedPartnerStore);
        await seedReferenceData(first);
        const a = await actors(first);
        const { tx, token } = await createAndInvite(first, a.seller);
        await first.transactions.acceptInvitation(a.buyer, token('BUYER'));
        await agree(first, a.seller, a.buyer, tx.id);
        const instruction = await first.payments.requestFundingInstructions(a.buyer, tx.id);

        // A new process (fresh MockPaymentProvider, empty process memory) on the same database.
        const second = createApp(env(url));
        track(() => second.persistence.close());
        await second.mockProvider.simulateFunding(instruction.providerReference);
        expect((await second.views.transaction(a.buyer, tx.id)).payment!.heldMinor).toBe('1850000');
        const m = await submitMilestone(second, a.seller, tx.id, 0);
        await second.milestones.review(a.buyer, tx.id, m, { decision: 'APPROVE' });

        // Another instance sees the transfer submitted through the second one and settles it.
        const third = createApp(env(url));
        track(() => third.persistence.close());
        expect((await third.mockProvider.pendingTransfers()).map((t) => [t.kind, t.status])).toEqual([['PAYOUT', 'SUBMITTED']]);
        await payAllSubmitted(third);
        expect((await first.mockProvider.pendingTransfers()).map((t) => t.status)).toEqual(['PAID']);
        const rec = await first.reconciliation.run(a.finance);
        expect(rec.status).toBe('MATCHED');
        expect(rec.items.map((i) => i.kind).sort()).toEqual(['FUNDS_RECEIVED', 'PAYOUT_PAID']);
    });

    it('never joins the caller’s unit of work: its writes are committed on their own connection and survive a rollback', async () => {
        const { url, track } = await database();
        const app = createApp(env(url));
        track(() => app.persistence.close());
        const raw = new pg.Client({ connectionString: url });
        await raw.connect();
        track(() => raw.end());
        const count = async () => (await raw.query('select count(*)::int as n from trustcargo_sim.instructions')).rows[0].n as number;
        await expect(
            app.deps.uow.run(async (db) => {
                await db.users.list({ limit: 1 }); // the unit of work now holds its transaction and the global lock
                await app.mockProvider.createPaymentInstruction({
                    transactionId: app.deps.ids.id(),
                    transactionReference: 'TC-2026-00001',
                    amount: money(1_850_000n, 'CAD'),
                    payerName: 'Awa Ndiaye',
                    idempotencyKey: 'fund:rollback'
                });
                // Already committed and visible to another connection while the unit of work is still open.
                expect(await count()).toBe(1);
                throw new Error('unit of work rolled back');
            })
        ).rejects.toThrow('unit of work rolled back');
        expect(await count()).toBe(1);
        const sessions = await raw.query(
            "select count(*)::int as n from pg_stat_activity where datname = current_database() and application_name = 'trustcargo-pay-simulated-partner'"
        );
        expect(sessions.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('stays idempotent across instances: concurrent requests with one key create a single instruction', async () => {
        const { url, track } = await database();
        const stores = [0, 1].map(() => new PostgresSimulatedPartnerStore({ url, role: 'service_role', poolMax: 2 }));
        for (const store of stores) track(() => store.close());
        const results = await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
                stores[i % 2]!.createInstruction({
                    reference: `sim_pi_race${i}`,
                    idempotencyKey: 'fund:race',
                    amount: money(1_850_000n, 'CAD'),
                    status: 'CREATED'
                })
            )
        );
        expect(new Set(results.map((r) => r.reference)).size).toBe(1);
        const raw = new pg.Client({ connectionString: url });
        await raw.connect();
        track(() => raw.end());
        expect((await raw.query('select count(*)::int as n from trustcargo_sim.instructions')).rows[0].n).toBe(1);
    });

    it('rejects a call whose backend is lost, without any uncaught error, and keeps working', async () => {
        const { url, track } = await database();
        const store = new PostgresSimulatedPartnerStore({ url, role: 'service_role', poolMax: 2 });
        track(() => store.close());
        const [holder, observer] = [new pg.Client({ connectionString: url }), new pg.Client({ connectionString: url })];
        for (const client of [holder, observer]) {
            await client.connect();
            track(() => client.end());
        }
        await store.createInstruction({
            reference: 'sim_pi_lost',
            idempotencyKey: 'fund:lost',
            amount: money(1_850_000n, 'CAD'),
            status: 'CREATED'
        });
        const problems = captureProcessErrors();

        // The partner's update waits on a row lock; its backend is terminated meanwhile (failover, pooler restart...).
        await holder.query('begin');
        await holder.query("select 1 from trustcargo_sim.instructions where reference = 'sim_pi_lost' for update");
        const outcome = store.setInstructionStatus('sim_pi_lost', 'FUNDED').then(
            () => 'resolved',
            () => 'rejected'
        );
        const pid = await waitFor(async () => {
            const { rows } = await observer.query(
                `select pid from pg_stat_activity where datname = current_database()
                 and application_name = 'trustcargo-pay-simulated-partner' and wait_event_type = 'Lock'`
            );
            return rows[0]?.pid as number | undefined;
        });
        await observer.query('select pg_terminate_backend($1)', [pid]);
        expect(await outcome).toBe('rejected');
        await holder.query('rollback');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(problems).toEqual([]);
        expect((await store.getInstruction('sim_pi_lost'))?.status).toBe('CREATED');
    });

    it('closes the simulated partner pool with persistence.close()', async () => {
        const { url } = await database();
        const app = createApp(env(url));
        expect(await app.mockProvider.pendingTransfers()).toEqual([]);
        await app.persistence.close();
        await expect(app.mockProvider.pendingTransfers()).rejects.toThrow();
    });
});
