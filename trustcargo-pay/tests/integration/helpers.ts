import { onTestFinished } from 'vitest';
import { createApp, type App } from '@/server/app';
import { loadConfig } from '@/server/config';
import { personaActor, seedReferenceData } from '@/server/demo/seed';
import type { Actor } from '@/server/auth/actor';
import { createTestDatabase, usePostgres } from './pg-test-db';

const BASE_ENV = {
    TRUSTCARGO_MODE: 'demo',
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    APP_URL: 'http://localhost:3000'
};

/**
 * Fresh application seeded with reference data. In-memory by default; with TEST_PG_ADMIN_URL
 * (scripts/test-integration-pg.sh) it runs on its own empty migrated Postgres database, connected as
 * service_role, which is dropped when the test finishes.
 */
export async function createTestApp(options: { seed?: boolean } = {}): Promise<App> {
    let env: Record<string, string> = BASE_ENV;
    if (usePostgres) {
        const database = await createTestDatabase();
        env = { ...BASE_ENV, DATABASE_URL: database.url, DATABASE_ROLE: 'service_role', DATABASE_POOL_MAX: '2' };
        const app = createApp(loadConfig(env as unknown as NodeJS.ProcessEnv));
        onTestFinished(async () => {
            await app.persistence.close();
            await database.drop();
        });
        if (options.seed !== false) await seedReferenceData(app);
        return app;
    }
    const app = createApp(loadConfig(env as unknown as NodeJS.ProcessEnv));
    if (options.seed !== false) await seedReferenceData(app);
    return app;
}

export async function actors(app: App) {
    const keys = [
        'seller',
        'buyer',
        'buyer2',
        'inspector',
        'forwarder',
        'compliance',
        'reviewer',
        'disputes',
        'finance',
        'admin',
        'auditor'
    ] as const;
    const out = {} as Record<(typeof keys)[number], Actor>;
    for (const k of keys) out[k] = await personaActor(app, k);
    return out;
}

export function withoutMfa(actor: Actor): Actor {
    return { ...actor, mfaVerifiedAt: undefined };
}
