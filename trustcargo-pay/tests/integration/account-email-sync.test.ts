/**
 * Sign-in keeps the profile e-mail on the provider's verified address (finding: stale profile e-mail authorising
 * invitations). Runs on the in-memory adapter and, with TEST_PG_ADMIN_URL, on Postgres (unique index on
 * lower(email), users_guard trigger). The provider is a minimal fake: nothing here talks to Supabase.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { User } from '@/domain/model';
import { createApp, type App } from '@/server/app';
import { loadConfig } from '@/server/config';
import { personaActor, seedReferenceData } from '@/server/demo/seed';
import type { AuthGateway, VerifiedIdentity } from '@/server/ports/auth-gateway';
import type { AuthContext, SessionControl } from '@/server/services/account-service';
import { createTestDatabase, usePostgres } from './pg-test-db';

async function setup(): Promise<{ app: App; addUser(email: string): Promise<User> }> {
    const database = usePostgres ? await createTestDatabase() : undefined;
    const url = database?.url;
    const env = {
        TRUSTCARGO_MODE: 'demo',
        SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
        ...(url ? { DATABASE_URL: url, STORAGE_PROVIDER: 'memory', DATABASE_POOL_MAX: '2' } : {})
    };
    const app = createApp(loadConfig(env as unknown as NodeJS.ProcessEnv));
    onTestFinished(async () => {
        await app.persistence.close();
        await database?.drop();
    });
    await seedReferenceData(app);
    const addUser = async (email: string) => {
        const user: User = {
            id: randomUUID(),
            email,
            fullName: 'Bob Martin',
            country: 'CA',
            locale: 'fr',
            platformRoles: [],
            kycStatus: 'NOT_STARTED',
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
            isDemo: false
        };
        if (url) {
            const client = new pg.Client({ connectionString: url });
            await client.connect();
            await client.query('insert into auth.users (id, email) values ($1, $2)', [user.id, email]);
            await client.end();
        }
        return app.deps.uow.run((db) => db.users.insert(user));
    };
    return { app, addUser };
}

function context(identity: VerifiedIdentity): AuthContext & { started: string[] } {
    const started: string[] = [];
    const gateway = {
        exchangeCode: async () => undefined,
        currentIdentity: async () => identity,
        signOut: async () => undefined
    } as unknown as AuthGateway;
    const session = {
        currentUserId: async () => undefined,
        start: async (id: string) => void started.push(id)
    } as unknown as SessionControl;
    return { gateway, session, client: { ip: '203.0.113.7', userAgent: 'vitest' }, started };
}

describe(`profile e-mail follows the verified provider address (${usePostgres ? 'Postgres' : 'memory'})`, () => {
    it('updates it in the sign-in unit of work with a pseudonymised audit event', async () => {
        const { app, addUser } = await setup();
        const user = await addUser('bob@corp.example');
        const ctx = context({ authUserId: user.id, email: 'bob@mail.example', emailConfirmed: true });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/dashboard' });
        expect(ctx.started).toEqual([user.id]);
        const { stored, events } = await app.deps.uow.run(async (db) => ({
            stored: await db.users.get(user.id),
            events: await db.auditEvents.findBy({ entityId: user.id })
        }));
        expect(stored!.email).toBe('bob@mail.example');
        expect(events.map((e) => e.action)).toEqual(['user.email_synced', 'auth.signed_in']);
        expect(JSON.stringify(events)).not.toContain('@');
        expect((await app.admin.auditLog(await personaActor(app, 'auditor'))).chain.valid).toBe(true);
    });

    it('refuses the sign-in, and changes nothing, when another profile holds the new address', async () => {
        const { app, addUser } = await setup();
        const user = await addUser('bob@corp.example');
        await addUser('bob@mail.example');
        const ctx = context({ authUserId: user.id, email: 'bob@mail.example', emailConfirmed: true });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/?auth=error' });
        expect(ctx.started).toEqual([]);
        expect((await app.deps.uow.run((db) => db.users.get(user.id)))!.email).toBe('bob@corp.example');
    });
});
