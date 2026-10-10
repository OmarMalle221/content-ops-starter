/**
 * First boot (src/server/instance.ts seedIfEmpty): boot checks and the seed run in ONE unit of work, with a
 * completion marker. In memory by default; with TEST_PG_ADMIN_URL (scripts/test-integration-pg.sh) every
 * instance of a test shares one fresh migrated Postgres database, as instances of a deployment would.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { User } from '@/domain/model';
import { createApp, type App } from '@/server/app';
import { loadConfig } from '@/server/config';
import { PERSONAS } from '@/server/demo/personas';
import { seedDemoPersonas, seedReferenceData } from '@/server/demo/seed';
import { BootRefusedError, seedIfEmpty } from '@/server/instance';
import { createTestDatabase, usePostgres } from './pg-test-db';

const BASE_ENV = {
    TRUSTCARGO_MODE: 'demo',
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    APP_URL: 'http://localhost:3000'
};
const SUPABASE_AUTH = {
    AUTH_PROVIDER: 'supabase',
    SUPABASE_URL: 'https://project-ref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_integration_test_0123456789'
};

/** Instances of one deployment. Postgres: they share one database. Memory: each instance has its own state. */
async function deployment(env: Record<string, string> = {}) {
    const apps: App[] = [];
    let url: string | undefined;
    if (usePostgres) {
        const database = await createTestDatabase();
        url = database.url;
        onTestFinished(async () => {
            for (const app of apps) await app.persistence.close();
            await database.drop();
        });
    }
    const instance = (extra: Record<string, string> = {}) => {
        const persistence = url ? { DATABASE_URL: url, STORAGE_PROVIDER: 'memory', DATABASE_POOL_MAX: '2' } : {};
        const app = createApp(loadConfig({ ...BASE_ENV, ...persistence, ...env, ...extra } as unknown as NodeJS.ProcessEnv));
        apps.push(app);
        return app;
    };
    /** A restart: a new instance on the same database (Postgres), or the same instance (memory state is per process). */
    const restart = (app: App) => (url ? instance() : app);
    return { instance, restart, url };
}

async function state(app: App) {
    return app.deps.uow.run(async (db) => ({
        users: (await db.users.list()).length,
        transactions: (await db.transactions.list()).length,
        securitySettings: Boolean(await db.securitySettings.get('default')),
        corridors: (await db.corridors.list()).length,
        providerConnections: (await db.providerConnections.list()).length,
        auditEvents: (await db.auditEvents.list()).length,
        markers: (await db.auditEvents.findBy({ action: 'system.seed_completed' })).map((e) => e.metadata)
    }));
}

/** Nothing seeded. (On Postgres the migration itself creates the security settings row, with defaults.) */
const EMPTY = {
    users: 0,
    transactions: 0,
    securitySettings: usePostgres,
    corridors: 0,
    providerConnections: 0,
    auditEvents: 0,
    markers: []
};

async function insertRealUser(app: App, url: string | undefined): Promise<User> {
    const user: User = {
        id: randomUUID(),
        email: 'real.person@example.test',
        fullName: 'Real Person',
        country: 'SN',
        locale: 'fr',
        platformRoles: [],
        kycStatus: 'NOT_STARTED',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        isDemo: false
    };
    if (url) {
        // On Supabase a real profile's id is an auth.users id (enforced by a trigger).
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        await client.query('insert into auth.users (id, email) values ($1, $2)', [user.id, user.email]);
        await client.end();
    }
    return app.deps.uow.run((db) => db.users.insert(user));
}

describe(`first boot (${usePostgres ? 'Postgres' : 'memory'})`, () => {
    it('seeds the persona demo in one unit of work, writes the completion marker last and never seeds again', async () => {
        const { instance, restart } = await deployment();
        const app = instance();
        expect(await seedIfEmpty(app)).toBe(true);
        const seeded = await state(app);
        expect(seeded).toMatchObject({ users: PERSONAS.length, transactions: 5, securitySettings: true, markers: [{ personas: true }] });
        const log = await app.deps.uow.run((db) => db.auditEvents.list());
        expect(log.at(-1)).toMatchObject({ action: 'system.seed_completed', actorType: 'SYSTEM', sequence: log.length });

        const next = restart(app);
        expect(await seedIfEmpty(next)).toBe(false);
        expect(await state(next)).toEqual(seeded);
    });

    it('rolls an interrupted seed back entirely, so the next boot seeds from scratch', async () => {
        const { instance, restart } = await deployment();
        const app = instance();
        // The partner fails on its first call, deep into the scenarios (after reference data, personas, a transaction).
        app.mockProvider.simulateOutage(1);
        await expect(seedIfEmpty(app)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
        expect(await state(app)).toEqual(EMPTY);

        const next = restart(app);
        expect(await seedIfEmpty(next)).toBe(true);
        expect(await state(next)).toMatchObject({ users: PERSONAS.length, transactions: 5, markers: [{ personas: true }] });
    });

    it('refuses to serve data without a completed seed instead of serving it half-seeded', async () => {
        const { instance } = await deployment();
        const app = instance();
        await seedReferenceData(app); // e.g. an interrupted seed of an older version: data, no marker
        const before = await state(app);
        const refusal = await seedIfEmpty(app).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(BootRefusedError);
        expect((refusal as Error).message).toMatch(/no completed first-boot seed.*drop trustcargo, trustcargo_private and trustcargo_sim/);
        expect(await state(app)).toEqual(before);
    });

    it('seeds only the reference data needed to operate for Supabase accounts: no persona, no scenario', async () => {
        const { instance, restart } = await deployment(SUPABASE_AUTH);
        const app = instance();
        expect(app.config.personaLogin).toBe(false);
        expect(await seedIfEmpty(app)).toBe(true);
        const seeded = await state(app);
        expect(seeded).toEqual({
            users: 0,
            transactions: 0,
            securitySettings: true,
            corridors: 2,
            providerConnections: 1,
            auditEvents: 1,
            markers: [{ personas: false }]
        });
        const next = restart(app);
        expect(await seedIfEmpty(next)).toBe(false);
        expect(await state(next)).toEqual(seeded);
    });

    it('refuses persona sign-in (AUTH_PROVIDER=demo) on a database that holds a real account', async () => {
        const { instance, restart, url } = await deployment();
        const app = instance();
        expect(await seedIfEmpty(app)).toBe(true);
        await insertRealUser(app, url);
        const refusal = await seedIfEmpty(restart(app)).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(BootRefusedError);
        expect((refusal as Error).message).toMatch(/^AUTH_PROVIDER=demo refuses this database: it holds real accounts/);
    });

    it('refuses Supabase accounts on a persona demo database', async () => {
        const { instance } = await deployment(SUPABASE_AUTH);
        const app = instance();
        await seedDemoPersonas(app);
        const refusal = await seedIfEmpty(app).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(BootRefusedError);
        expect((refusal as Error).message).toMatch(/^AUTH_PROVIDER=supabase refuses this database: it is a persona demo/);
    });
});

describe.skipIf(!usePostgres)('first boot on Postgres: several instances', () => {
    it('lets a concurrent instance wait for the seed, then find it complete', async () => {
        const { instance } = await deployment();
        const [a, b] = [instance(), instance()];
        const results = await Promise.all([seedIfEmpty(a), seedIfEmpty(b)]);
        expect(results.sort()).toEqual([false, true]);
        expect(await state(b)).toMatchObject({ users: PERSONAS.length, transactions: 5, markers: [{ personas: true }] });
    });

    it('raises the lock and statement timeouts for the seed transaction only', async () => {
        const { instance } = await deployment();
        const app = instance();
        const query = vi.spyOn(pg.Client.prototype, 'query');
        // Unit-of-work timeout statements only (the simulated partner's own pool sets its own).
        const timeouts = () =>
            (query.mock.calls as unknown as [unknown, unknown][])
                .filter(([text]) => typeof text === 'string' && /app_managed_updated_at|set_config\('statement_timeout', \$1/.test(text))
                .map(([, values]) => values);
        await app.deps.uow.run((db) => db.users.list({ limit: 1 }));
        expect(timeouts()).toEqual([['10s', '20s', 'service_role']]);
        query.mockClear();
        await seedIfEmpty(app);
        expect(timeouts()).toEqual([['10s', '20s', 'service_role'], ['15min']]);
    });
});
