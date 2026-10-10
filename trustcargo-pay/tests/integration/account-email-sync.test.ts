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
import type { Actor } from '@/server/auth/actor';
import { loadConfig } from '@/server/config';
import { personaActor, seedReferenceData } from '@/server/demo/seed';
import type { AuthGateway, VerifiedIdentity } from '@/server/ports/auth-gateway';
import type { AuthContext, SessionControl } from '@/server/services/account-service';
import { AuthGatewayError } from '@/server/ports/auth-gateway';
import { createAndInvite } from './flow';
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
        hasCodeVerifier: () => true,
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

    describe('before an invitation is listed, accepted or declined (AccountService.withVerifiedEmail)', () => {
        const actorOf = (user: User): Actor => ({ kind: 'USER', userId: user.id, email: user.email, platformRoles: [], sessionId: 's' });

        async function invitedBob() {
            const env = await setup();
            const bob = await env.addUser('bob@corp.example');
            const seller = await personaActor(env.app, 'seller');
            await createAndInvite(env.app, seller, { buyer: { fullName: 'Bob Martin', email: 'bob@corp.example' } });
            return { ...env, bob, stale: actorOf(bob) };
        }

        it('re-reads the provider address of a session opened before it changed, and matches invitations on it', async () => {
            const { app, bob, stale } = await invitedBob();
            const [invitation] = await app.transactions.pendingInvitations(stale);
            expect(invitation).toBeDefined();
            // The address moved at the provider (bob@corp.example now belongs to someone else) while Bob's session lived on.
            const ctx = context({ authUserId: bob.id, email: 'Bob@Mail.Example', emailConfirmed: true });
            const verified = await app.accounts.withVerifiedEmail(ctx, stale);
            expect(verified).toEqual({ ...stale, email: 'bob@mail.example' });
            expect((await app.deps.uow.run((db) => db.users.get(bob.id)))!.email).toBe('bob@mail.example');
            expect(await app.transactions.pendingInvitations(verified)).toEqual([]);
            await expect(app.transactions.acceptInvitationForParty(verified, invitation!.partyId)).rejects.toMatchObject({
                code: 'FORBIDDEN'
            });
            const synced = await app.deps.uow.run((db) => db.auditEvents.findBy({ action: 'user.email_synced', entityId: bob.id }));
            expect(synced).toHaveLength(1);
            expect(JSON.stringify(synced)).not.toContain('@');
        });

        it('keeps the actor when the provider confirms the address, and needs no provider for demo personas', async () => {
            const { app, bob, stale } = await invitedBob();
            const ctx = context({ authUserId: bob.id, email: 'bob@corp.example', emailConfirmed: true });
            expect(await app.accounts.withVerifiedEmail(ctx, stale)).toBe(stale);
            expect(await app.transactions.pendingInvitations(stale)).toHaveLength(1);
            expect(await app.accounts.withVerifiedEmail({ gateway: undefined }, stale)).toBe(stale);
        });

        it('refuses, and changes nothing, when another profile holds the verified address (same rule as sign-in)', async () => {
            const { app, bob, stale, addUser } = await invitedBob();
            await addUser('bob@mail.example');
            const ctx = context({ authUserId: bob.id, email: 'bob@mail.example', emailConfirmed: true });
            await expect(app.accounts.withVerifiedEmail(ctx, stale)).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect((await app.deps.uow.run((db) => db.users.get(bob.id)))!.email).toBe('bob@corp.example');
            const refused = await app.deps.uow.run((db) => db.auditEvents.findBy({ action: 'auth.email_recheck_refused' }));
            expect(refused.map((e) => e.metadata)).toEqual([{ reason: 'email_belongs_to_another_account' }]);
        });

        it('refuses without a provider session of this very user, and when the provider is unreachable', async () => {
            const { app, bob, stale } = await invitedBob();
            const other = context({ authUserId: randomUUID(), email: 'bob@corp.example', emailConfirmed: true });
            await expect(app.accounts.withVerifiedEmail(other, stale)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
            const unconfirmed = context({ authUserId: bob.id, email: 'bob@corp.example', emailConfirmed: false });
            await expect(app.accounts.withVerifiedEmail(unconfirmed, stale)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
            const down = context({ authUserId: bob.id, email: 'bob@corp.example', emailConfirmed: true });
            down.gateway!.currentIdentity = async () => {
                throw new AuthGatewayError('unavailable');
            };
            await expect(app.accounts.withVerifiedEmail(down, stale)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        });
    });
});
