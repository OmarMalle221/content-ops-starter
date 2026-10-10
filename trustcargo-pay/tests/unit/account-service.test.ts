import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/domain/model';
import { createApp, type App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { loadConfig } from '@/server/config';
import { DEMO_TOTP_SECRET, PERSONAS } from '@/server/demo/personas';
import { personaActor, seedReferenceData } from '@/server/demo/seed';
import { logger } from '@/server/logger';
import {
    AuthGatewayError,
    type AssuranceLevel,
    type AuthGateway,
    type TotpFactor,
    type VerifiedIdentity
} from '@/server/ports/auth-gateway';
import { totp } from '@/server/security/totp';
import type { AuthContext, SessionControl } from '@/server/services/account-service';

// The account flows run against a fake AuthGateway: nothing here talks to a real Supabase project.

const APP_URL = 'https://app.trustcargo.test';
const VALID_CODE = '246810';

class FakeGateway implements AuthGateway {
    calls: string[] = [];
    sent: { email: string; redirectTo: string }[] = [];
    identity: VerifiedIdentity | undefined;
    factors: TotpFactor[] = [];
    aal: AssuranceLevel | undefined = 'aal1';
    aalAfterVerify: AssuranceLevel = 'aal2';
    failWith?: AuthGatewayError;

    async sendMagicLink(email: string, redirectTo: string) {
        this.calls.push('sendMagicLink');
        if (this.failWith) throw this.failWith;
        this.sent.push({ email, redirectTo });
    }
    async exchangeCode(code: string) {
        this.calls.push(`exchangeCode:${code}`);
        if (this.failWith) throw this.failWith;
    }
    async currentIdentity() {
        if (this.failWith?.reason === 'unavailable') throw this.failWith;
        return this.identity;
    }
    async listTotpFactors() {
        return this.factors;
    }
    async enrolTotp() {
        this.calls.push('enrolTotp');
        const factor = { id: `factor-${this.factors.length + 1}`, verified: false, createdAt: new Date().toISOString() };
        this.factors.push(factor);
        return { factorId: factor.id, qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'JBSWY3DPEHPK3PXP' };
    }
    async challengeAndVerifyTotp(factorId: string, code: string) {
        this.calls.push(`challengeAndVerify:${factorId}`);
        if (code !== VALID_CODE) throw new AuthGatewayError('rejected', 'mfa_verification_failed');
        this.factors = this.factors.map((f) => (f.id === factorId ? { ...f, verified: true } : f));
        this.aal = this.aalAfterVerify;
    }
    async currentAssuranceLevel() {
        return this.aal;
    }
    async signOut() {
        this.calls.push('signOut');
        this.identity = undefined;
    }
}

class FakeSession implements SessionControl {
    started: string[] = [];
    mfaMarked = 0;
    ended = 0;
    onboarding: string | undefined;
    /** User of the browser's current tc_session. */
    current: string | undefined;
    async currentUserId() {
        return this.current;
    }
    async start(userId: string) {
        this.started.push(userId);
        this.current = userId;
    }
    async markMfaVerified() {
        this.mfaMarked += 1;
    }
    async end() {
        this.ended += 1;
        this.current = undefined;
    }
    async startOnboarding(authUserId: string) {
        this.onboarding = authUserId;
    }
    async pendingOnboarding() {
        return this.onboarding;
    }
    async endOnboarding() {
        this.onboarding = undefined;
    }
}

async function setup() {
    const app = createApp(
        loadConfig({
            TRUSTCARGO_MODE: 'demo',
            SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
            MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
            APP_URL
        } as unknown as NodeJS.ProcessEnv)
    );
    await seedReferenceData(app);
    const gateway = new FakeGateway();
    const session = new FakeSession();
    const ctx: AuthContext = { gateway, session, client: { ip: '203.0.113.7', userAgent: 'vitest' } };
    return { app, gateway, session, ctx };
}

function identity(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
    return { authUserId: randomUUID(), email: 'amina.diallo@example.test', emailConfirmed: true, ...overrides };
}

async function insertUser(app: App, overrides: Partial<User> = {}): Promise<User> {
    const user: User = {
        id: randomUUID(),
        email: 'amina.diallo@example.test',
        fullName: 'Amina Diallo',
        country: 'SN',
        city: 'Dakar',
        locale: 'fr',
        platformRoles: [],
        kycStatus: 'NOT_STARTED',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        isDemo: false,
        ...overrides
    };
    return app.deps.uow.run((db) => db.users.insert(user));
}

function actorOf(user: User): Actor {
    return { kind: 'USER', userId: user.id, email: user.email, platformRoles: user.platformRoles, sessionId: 'sid' };
}

async function auditActions(app: App) {
    return (await app.deps.uow.run((db) => db.auditEvents.list())).map((e) => e.action);
}

describe('magic link request', () => {
    it('answers identically for an existing account, an unknown address and a provider failure', async () => {
        const { app, gateway, ctx } = await setup();
        const existing = await app.accounts.requestMagicLink({ gateway, client: ctx.client }, PERSONAS[0]!.email);
        const unknown = await app.accounts.requestMagicLink({ gateway, client: ctx.client }, '  Nobody@Example.TEST ');
        gateway.failWith = new AuthGatewayError('rejected', 'email_address_not_authorized');
        const failing = await app.accounts.requestMagicLink({ gateway, client: ctx.client }, 'blocked@example.test');
        expect(existing).toEqual({ kind: 'ok', data: undefined });
        expect(unknown).toEqual(existing);
        expect(failing).toEqual(existing);
        expect(gateway.sent).toEqual([
            { email: PERSONAS[0]!.email, redirectTo: `${APP_URL}/auth/callback` },
            { email: 'nobody@example.test', redirectTo: `${APP_URL}/auth/callback` }
        ]);
    });

    it('validates the address format without calling the provider', async () => {
        const { app, gateway, ctx } = await setup();
        expect(await app.accounts.requestMagicLink({ gateway, client: ctx.client }, 'not-an-email')).toEqual({
            kind: 'error',
            code: 'VALIDATION',
            fields: ['email']
        });
        expect(gateway.calls).toEqual([]);
    });

    it('throttles silently per pseudonymised address and explicitly per IP, never logging the raw address', async () => {
        const { app, gateway, ctx } = await setup();
        const info = vi.spyOn(logger, 'info');
        const warn = vi.spyOn(logger, 'warn');
        const results = [];
        for (let i = 0; i < 5; i += 1) {
            results.push(
                await app.accounts.requestMagicLink({ gateway, client: { ip: `198.51.100.${i}`, userAgent: 'x' } }, 'victim@example.test')
            );
        }
        expect(results.every((r) => r.kind === 'ok')).toBe(true);
        expect(gateway.sent).toHaveLength(3);
        const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
        expect(logged).toContain('auth.magic_link_throttled');
        expect(logged).not.toContain('victim@example.test');

        for (let i = 0; i < 10; i += 1) await app.accounts.requestMagicLink({ gateway, client: ctx.client }, `user${i}@example.test`);
        expect(await app.accounts.requestMagicLink({ gateway, client: ctx.client }, 'user99@example.test')).toEqual({
            kind: 'error',
            code: 'RATE_LIMITED'
        });
    });

    it('caps the links sent per process, whatever the client IP, to protect the project e-mail quota', async () => {
        const { app, gateway } = await setup();
        const results = [];
        for (let i = 0; i < 25; i += 1) {
            results.push(
                await app.accounts.requestMagicLink({ gateway, client: { ip: `198.51.100.${i}`, userAgent: 'x' } }, `u${i}@example.test`)
            );
        }
        expect(gateway.sent).toHaveLength(20);
        expect(results.slice(20)).toEqual(Array(5).fill({ kind: 'error', code: 'RATE_LIMITED' }));
    });
});

describe('e-mail link callback', () => {
    it('signs in an existing active user, records an honest session event and honours a safe next', async () => {
        const { app, gateway, session, ctx } = await setup();
        const user = await insertUser(app);
        gateway.identity = identity({ authUserId: user.id, email: 'Amina.Diallo@example.test' });
        const result = await app.accounts.completeSignIn(ctx, { code: 'pkce-code', next: '/transactions/abc' });
        expect(result).toEqual({ kind: 'redirect', to: '/transactions/abc' });
        expect(gateway.calls).toEqual(['exchangeCode:pkce-code']);
        expect(session.started).toEqual([user.id]);
        const events = await app.deps.uow.run((db) => db.sessionEvents.findBy({ userId: user.id }));
        expect(events).toHaveLength(1);
        expect(events[0]!.country).toBe('SN');
        expect(events[0]!.ipHash).not.toContain('203.0.113.7');
        expect(await auditActions(app)).toContain('auth.signed_in');
    });

    it('falls back to /dashboard for an unsafe next and accepts the PKCE code only (token_hash links are ignored)', async () => {
        const { app, gateway, session, ctx } = await setup();
        const user = await insertUser(app);
        gateway.identity = identity({ authUserId: user.id });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c1', next: '/\\evil.example' })).toEqual({
            kind: 'redirect',
            to: '/dashboard'
        });
        // What the route would pass for `?token_hash=…&type=email`: no code, so nothing is verified.
        const tokenHashLink = { token_hash: 'th_1', type: 'email' } as unknown as Parameters<App['accounts']['completeSignIn']>[1];
        expect(await app.accounts.completeSignIn(ctx, tokenHashLink)).toEqual({ kind: 'redirect', to: '/?auth=error' });
        expect(gateway.calls).toEqual(['exchangeCode:c1']);
        expect('verifyEmailLink' in gateway).toBe(false);
        expect(session.started).toEqual([user.id]);
    });

    it('never signs anybody out on a callback without a usable code (no logout CSRF)', async () => {
        const { app, gateway, session, ctx } = await setup();
        const user = await insertUser(app);
        session.current = user.id;
        gateway.identity = identity({ authUserId: user.id });
        // No parameter, an over-long code, a code the provider rejects, then the per-IP limit.
        expect(await app.accounts.completeSignIn(ctx, {})).toEqual({ kind: 'redirect', to: '/?auth=error' });
        expect(await app.accounts.completeSignIn(ctx, { code: 'x'.repeat(600) })).toEqual({ kind: 'redirect', to: '/?auth=error' });
        gateway.failWith = new AuthGatewayError('rejected', 'flow_state_not_found');
        expect(await app.accounts.completeSignIn(ctx, { code: 'forged' })).toEqual({ kind: 'redirect', to: '/?auth=error' });
        for (let i = 0; i < 25; i += 1) await app.accounts.completeSignIn(ctx, {});
        expect(gateway.calls).toEqual(['exchangeCode:forged']);
        expect(gateway.calls).not.toContain('signOut');
        expect(gateway.identity?.authUserId).toBe(user.id);
        expect(session).toMatchObject({ current: user.id, ended: 0, started: [] });
    });

    it('ends and audits the session of another user instead of silently replacing it', async () => {
        const { app, gateway, session, ctx } = await setup();
        const previous = await personaActor(app, 'buyer');
        const user = await insertUser(app);
        session.current = previous.userId;
        gateway.identity = identity({ authUserId: user.id });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/dashboard' });
        expect(session).toMatchObject({ ended: 1, started: [user.id], current: user.id });
        const ended = await app.deps.uow.run((db) => db.auditEvents.findBy({ action: 'auth.session_ended' }));
        expect(ended.map((e) => [e.entityId, e.metadata])).toEqual([[previous.userId, { reason: 'another_account_signed_in' }]]);

        // The same user signing in again keeps nothing else to end; a new identity going to onboarding ends it too.
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/dashboard' });
        expect(session.ended).toBe(1);
        gateway.identity = identity({ email: 'newcomer@example.test' });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/onboarding' });
        expect(session).toMatchObject({ ended: 2, current: undefined, onboarding: gateway.identity.authUserId });
    });

    it('updates the profile e-mail to the verified provider address, auditing pseudonymised addresses only', async () => {
        const { app, gateway, session, ctx } = await setup();
        const user = await insertUser(app, { email: 'bob@corp.example' });
        gateway.identity = identity({ authUserId: user.id, email: 'Bob@Gmail.Example' });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/dashboard' });
        expect((await app.deps.uow.run((db) => db.users.get(user.id)))!.email).toBe('bob@gmail.example');
        expect(session.started).toEqual([user.id]);
        const synced = await app.deps.uow.run((db) => db.auditEvents.findBy({ action: 'user.email_synced' }));
        expect(synced).toHaveLength(1);
        expect(synced[0]!.metadata).toEqual({
            previousEmailHash: expect.stringMatching(/^[0-9a-f]{32}$/),
            emailHash: expect.stringMatching(/^[0-9a-f]{32}$/),
            provider: 'supabase'
        });
        expect(JSON.stringify(await app.deps.uow.run((db) => db.auditEvents.list()))).not.toMatch(/bob@/i);
    });

    it('refuses a changed verified address that another profile already uses, and changes nothing', async () => {
        const { app, gateway, session, ctx } = await setup();
        const user = await insertUser(app, { email: 'bob@corp.example' });
        gateway.identity = identity({ authUserId: user.id, email: PERSONAS[0]!.email });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/?auth=error' });
        expect((await app.deps.uow.run((db) => db.users.get(user.id)))!.email).toBe('bob@corp.example');
        expect(session.started).toEqual([]);
        expect(gateway.calls).toContain('signOut');
        const refused = await app.deps.uow.run((db) => db.auditEvents.findBy({ action: 'auth.sign_in_refused' }));
        expect(refused.map((e) => e.metadata)).toEqual([{ reason: 'email_belongs_to_another_account' }]);
        expect(await auditActions(app)).not.toContain('user.email_synced');
    });

    it('caps code exchanges per process, whatever the client IP', async () => {
        const { app, gateway, ctx } = await setup();
        gateway.failWith = new AuthGatewayError('rejected', 'flow_state_not_found');
        for (let i = 0; i < 130; i += 1) {
            await app.accounts.completeSignIn({ ...ctx, client: { ip: `198.51.100.${i % 250}`, userAgent: 'x' } }, { code: `c${i}` });
        }
        expect(gateway.calls.filter((c) => c.startsWith('exchangeCode'))).toHaveLength(120);
    });

    it('sends a verified identity without profile to onboarding', async () => {
        const { app, gateway, session, ctx } = await setup();
        const id = identity();
        gateway.identity = id;
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/onboarding' });
        expect(session.onboarding).toBe(id.authUserId);
        expect(session.started).toEqual([]);
    });

    it('refuses an address that belongs to another profile (no silent linking with a demo persona)', async () => {
        const { app, gateway, session, ctx } = await setup();
        gateway.identity = identity({ email: PERSONAS[0]!.email.toUpperCase() });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/?auth=error' });
        expect(session.started).toEqual([]);
        expect(session.onboarding).toBeUndefined();
        expect(gateway.calls).toContain('signOut');
        expect(await auditActions(app)).toContain('auth.sign_in_refused');
    });

    it('refuses an unconfirmed e-mail address, a suspended user, a rejected link and a disabled provider', async () => {
        const { app, gateway, session, ctx } = await setup();
        gateway.identity = identity({ emailConfirmed: false });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/?auth=error' });

        const suspended = await insertUser(app, { email: 'suspended@example.test', status: 'SUSPENDED' });
        gateway.identity = identity({ authUserId: suspended.id, email: suspended.email });
        expect(await app.accounts.completeSignIn(ctx, { code: 'c' })).toEqual({ kind: 'redirect', to: '/?auth=error' });

        gateway.identity = identity();
        gateway.failWith = new AuthGatewayError('rejected', 'otp_expired');
        expect(await app.accounts.completeSignIn(ctx, { code: 'expired' })).toEqual({ kind: 'redirect', to: '/?auth=error' });

        expect(await app.accounts.completeSignIn({ ...ctx, gateway: undefined }, { code: 'c' })).toEqual({
            kind: 'redirect',
            to: '/?auth=error'
        });
        expect(session.started).toEqual([]);
        expect(session.onboarding).toBeUndefined();
    });
});

describe('onboarding', () => {
    const form = { fullName: '  Amina Diallo ', country: 'sn', city: 'Dakar', phone: '+221 77 000 00 00', locale: 'fr' };

    it('creates the profile with the identity e-mail (never the form), no staff role, then opens the session', async () => {
        const { app, gateway, session, ctx } = await setup();
        const id = identity({ email: 'Amina.Diallo@Example.test' });
        gateway.identity = id;
        session.onboarding = id.authUserId;
        const result = await app.accounts.completeOnboarding(ctx, {
            ...form,
            email: 'attacker@evil.example',
            platformRoles: ['platform_admin']
        });
        expect(result).toEqual({ kind: 'redirect', to: '/dashboard' });
        const user = await app.deps.uow.run((db) => db.users.get(id.authUserId));
        expect(user).toMatchObject({
            id: id.authUserId,
            email: 'amina.diallo@example.test',
            fullName: 'Amina Diallo',
            country: 'SN',
            city: 'Dakar',
            phone: '+221 77 000 00 00',
            locale: 'fr',
            platformRoles: [],
            kycStatus: 'NOT_STARTED',
            status: 'ACTIVE',
            isDemo: false
        });
        expect(user!.mfaTotpSecret).toBeUndefined();
        expect(session.started).toEqual([id.authUserId]);
        expect(session.onboarding).toBeUndefined();
        expect(await auditActions(app)).toEqual(expect.arrayContaining(['user.registered', 'auth.signed_in']));
    });

    it('validates the form', async () => {
        const { app, gateway, session, ctx } = await setup();
        const id = identity();
        gateway.identity = id;
        session.onboarding = id.authUserId;
        const result = await app.accounts.completeOnboarding(ctx, { fullName: 'A', country: 'ZZ', phone: 'call me', locale: 'de' });
        expect(result).toEqual({
            kind: 'error',
            code: 'VALIDATION',
            fields: expect.arrayContaining(['fullName', 'country', 'phone', 'locale'])
        });
        expect(await app.accounts.completeOnboarding(ctx, { ...form, country: 'Canada' })).toMatchObject({
            code: 'VALIDATION',
            fields: ['country']
        });
        expect(await app.deps.uow.run((db) => db.users.get(id.authUserId))).toBeUndefined();
    });

    it('requires the pending marker and a matching, verified provider identity', async () => {
        const { app, gateway, session, ctx } = await setup();
        gateway.identity = identity();
        expect(await app.accounts.completeOnboarding(ctx, form)).toEqual({ kind: 'redirect', to: '/?auth=expired' });

        session.onboarding = randomUUID();
        expect(await app.accounts.completeOnboarding(ctx, form)).toEqual({ kind: 'redirect', to: '/?auth=expired' });
        expect(gateway.calls).toContain('signOut');
        expect(session.onboarding).toBeUndefined();
        expect(session.started).toEqual([]);
    });

    it('never links to an existing profile with the same address', async () => {
        const { app, gateway, session, ctx } = await setup();
        const id = identity({ email: PERSONAS[1]!.email });
        gateway.identity = id;
        session.onboarding = id.authUserId;
        expect(await app.accounts.completeOnboarding(ctx, form)).toEqual({ kind: 'error', code: 'ACCOUNT_EXISTS' });
        expect(await app.deps.uow.run((db) => db.users.get(id.authUserId))).toBeUndefined();
        expect(session.started).toEqual([]);
    });
});

describe('step-up MFA', () => {
    async function realUser() {
        const env = await setup();
        const user = await insertUser(env.app);
        env.gateway.identity = identity({ authUserId: user.id, email: user.email });
        return { ...env, user, actor: actorOf(user) };
    }

    it('enrols a TOTP factor when none is verified, then requires AAL2 before marking the session', async () => {
        const { app, gateway, session, ctx, actor } = await realUser();
        expect(await app.accounts.prepareMfa(ctx, actor)).toEqual({
            kind: 'ok',
            data: { mode: 'enrol', qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'JBSWY3DPEHPK3PXP' }
        });
        expect(await app.accounts.verifyMfa(ctx, actor, '246 810', '/admin/disputes')).toEqual({ kind: 'redirect', to: '/admin/disputes' });
        expect(gateway.calls).toEqual(['enrolTotp', 'challengeAndVerify:factor-1']);
        expect(session.mfaMarked).toBe(1);
        expect(await auditActions(app)).toEqual(expect.arrayContaining(['auth.mfa_enrolment_started', 'auth.mfa_verified']));
        // Next time the verified factor is challenged directly.
        expect(await app.accounts.prepareMfa(ctx, actor)).toEqual({ kind: 'ok', data: { mode: 'verify' } });
        expect(gateway.calls.filter((c) => c === 'enrolTotp')).toHaveLength(1);
    });

    it('does not mark the session when the provider session stays below AAL2', async () => {
        const { app, gateway, session, ctx, actor } = await realUser();
        gateway.factors = [{ id: 'f1', verified: true, createdAt: '2026-01-01T00:00:00Z' }];
        gateway.aalAfterVerify = 'aal1';
        expect(await app.accounts.verifyMfa(ctx, actor, VALID_CODE, '/dashboard')).toEqual({ kind: 'error', code: 'MFA_INVALID' });
        expect(session.mfaMarked).toBe(0);
        const failed = await app.deps.uow.run((db) => db.auditEvents.findBy({ action: 'auth.mfa_failed' }));
        expect(failed[0]!.metadata).toMatchObject({ reason: 'aal2_not_reached' });
    });

    it('rejects a wrong code and rate-limits attempts (5 per 5 minutes)', async () => {
        const { app, gateway, session, ctx, actor } = await realUser();
        gateway.factors = [{ id: 'f1', verified: true, createdAt: '2026-01-01T00:00:00Z' }];
        for (let i = 0; i < 5; i += 1) {
            expect(await app.accounts.verifyMfa(ctx, actor, '000000', '/dashboard')).toEqual({ kind: 'error', code: 'MFA_INVALID' });
        }
        expect(await app.accounts.verifyMfa(ctx, actor, VALID_CODE, '/dashboard')).toEqual({ kind: 'error', code: 'RATE_LIMITED' });
        expect(gateway.calls.filter((c) => c.startsWith('challengeAndVerify'))).toHaveLength(5);
        expect(session.mfaMarked).toBe(0);
        expect((await auditActions(app)).filter((a) => a === 'auth.mfa_failed')).toHaveLength(5);
    });

    it('sends the user back to sign-in when the provider session is missing or belongs to someone else', async () => {
        const { app, gateway, session, ctx, actor } = await realUser();
        gateway.identity = identity();
        expect(await app.accounts.verifyMfa(ctx, actor, VALID_CODE, '/dashboard')).toEqual({ kind: 'redirect', to: '/?auth=expired' });
        gateway.identity = undefined;
        expect(await app.accounts.prepareMfa(ctx, actor)).toEqual({ kind: 'redirect', to: '/?auth=expired' });
        expect(session.ended).toBe(2);
        expect(session.mfaMarked).toBe(0);
        expect(gateway.calls.filter((c) => c.startsWith('challengeAndVerify'))).toHaveLength(0);
    });

    it('reports an unreachable provider without ending the session', async () => {
        const { app, gateway, session, ctx, actor } = await realUser();
        gateway.failWith = new AuthGatewayError('unavailable');
        expect(await app.accounts.verifyMfa(ctx, actor, VALID_CODE, '/dashboard')).toEqual({ kind: 'error', code: 'AUTH_UNAVAILABLE' });
        expect(session.ended).toBe(0);
    });

    it('keeps the local TOTP flow for demo personas, with the safe-redirect guard', async () => {
        const { app, session } = await setup();
        const admin = await personaActor(app, 'admin');
        const ctx: AuthContext = { session, client: { ip: '203.0.113.7', userAgent: 'vitest' } };
        expect(await app.accounts.verifyMfa(ctx, admin, '000000', '/admin')).toEqual({ kind: 'error', code: 'MFA_INVALID' });
        expect(await app.accounts.verifyMfa(ctx, admin, totp(DEMO_TOTP_SECRET), '//evil.example')).toEqual({
            kind: 'redirect',
            to: '/dashboard'
        });
        expect(session.mfaMarked).toBe(1);
    });

    it('signs out of the provider and ends the TrustCargo session, even if the provider fails', async () => {
        const { app, gateway, session, ctx } = await setup();
        gateway.signOut = async () => {
            throw new AuthGatewayError('unavailable');
        };
        await app.accounts.signOut(ctx);
        expect(session.ended).toBe(1);
    });
});
