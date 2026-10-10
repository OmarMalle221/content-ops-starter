/**
 * Account flows for real users authenticated by an external provider (Supabase Auth): magic-link request,
 * e-mail link callback, onboarding, step-up MFA (TOTP, AAL2) and sign-out. Demo personas keep their local TOTP.
 *
 * Framework-free on purpose: the provider is reached through the request-scoped `AuthGateway` port and the
 * cookies through `SessionControl`, so every branch is unit-tested with fakes. Server actions and the callback
 * route only translate the returned `FlowResult` into a redirect or an ActionState.
 */
import { z } from 'zod';
import type { User } from '@/domain/model';
import type { Actor } from '@/server/auth/actor';
import { SYSTEM } from '@/server/auth/actor';
import { logger } from '@/server/logger';
import { isAuthGatewayError, isEmailLinkType, type AuthGateway, type TotpFactor } from '@/server/ports/auth-gateway';
import { pseudonymize } from '@/server/security/crypto';
import type { RateLimiter } from '@/server/security/rate-limit';
import { safeRedirectPath } from '@/server/security/redirect';
import { verifyTotp } from '@/server/security/totp';
import { audit, type Deps } from './context';
import type { RiskService } from './risk-service';

/** Cookie side effects, implemented with next/headers in src/server/auth/session.ts. */
export interface SessionControl {
    start(userId: string): Promise<void>;
    markMfaVerified(): Promise<void>;
    end(): Promise<void>;
    /** Short-lived signed marker: this browser completed an e-mail link for `authUserId`, which has no profile yet. */
    startOnboarding(authUserId: string): Promise<void>;
    pendingOnboarding(): Promise<string | undefined>;
    endOnboarding(): Promise<void>;
}

export interface ClientInfo {
    ip: string;
    userAgent: string;
}

export interface AuthContext {
    /** Undefined when AUTH_PROVIDER=demo. */
    gateway?: AuthGateway;
    session: SessionControl;
    client: ClientInfo;
}

export type FlowErrorCode = 'VALIDATION' | 'RATE_LIMITED' | 'MFA_INVALID' | 'MFA_UNAVAILABLE' | 'AUTH_UNAVAILABLE' | 'ACCOUNT_EXISTS';

export type FlowResult<T = undefined> =
    { kind: 'ok'; data: T } | { kind: 'redirect'; to: string } | { kind: 'error'; code: FlowErrorCode; fields?: string[] };

export type MfaStep = { mode: 'verify' } | { mode: 'enrol'; qrCodeDataUrl?: string; secret: string };

export const AUTH_CALLBACK_PATH = '/auth/callback';
export const SIGN_IN_ERROR_PATH = '/?auth=error';
export const SIGN_IN_EXPIRED_PATH = '/?auth=expired';

const LIMITS = {
    magicLinkPerIp: { limit: 10, windowMs: 15 * 60_000 },
    magicLinkPerEmail: { limit: 3, windowMs: 15 * 60_000 },
    callbackPerIp: { limit: 20, windowMs: 5 * 60_000 },
    onboardingPerIp: { limit: 10, windowMs: 60 * 60_000 },
    // Same budget as the demo TOTP challenge: 5 attempts per 5 minutes and per user.
    mfa: { limit: 5, windowMs: 5 * 60_000 },
    mfaEnrolment: { limit: 5, windowMs: 15 * 60_000 }
};

const MAX_LINK_PARAM_LENGTH = 512;
const NOT_COUNTRIES = new Set(['ZZ', 'EU', 'EZ', 'UN', 'QO']);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Profile fields only. There is deliberately no `email` field: the address always comes from the verified identity. */
export const onboardingSchema = z.object({
    fullName: z.string().trim().min(2).max(200),
    country: z
        .string()
        .trim()
        .toUpperCase()
        // One check only: zod 4 keeps running refinements after a failed regex, and Intl throws on malformed codes.
        .refine((c) => /^[A-Z]{2}$/.test(c) && !NOT_COUNTRIES.has(c) && regionNames.of(c) !== undefined, 'ISO 3166-1 alpha-2'),
    city: z
        .string()
        .trim()
        .max(100)
        .optional()
        .transform((v) => v || undefined),
    phone: z
        .string()
        .trim()
        .optional()
        .transform((v) => v || undefined)
        .refine((v) => v === undefined || /^\+?[0-9 ().-]{6,20}$/.test(v)),
    locale: z.enum(['fr', 'en'])
});

const OK: FlowResult = { kind: 'ok', data: undefined };

function reasonOf(error: unknown): string {
    return isAuthGatewayError(error) ? [error.reason, error.providerCode].filter(Boolean).join(':') : 'unexpected';
}

function isLocalTotpUser(user: User): user is User & { mfaTotpSecret: string } {
    return user.isDemo && Boolean(user.mfaTotpSecret);
}

function actorFor(user: User): Actor {
    return { kind: 'USER', userId: user.id, email: user.email, platformRoles: user.platformRoles, sessionId: 'auth-flow' };
}

/** A verified factor wins; otherwise the most recent unverified one (enrolment in progress). */
function pickFactor(factors: TotpFactor[]): TotpFactor | undefined {
    const newestFirst = [...factors].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return newestFirst.find((f) => f.verified) ?? newestFirst[0];
}

export class AccountService {
    constructor(
        private readonly deps: Deps,
        private readonly rateLimiter: RateLimiter,
        private readonly risk: RiskService
    ) {}

    /**
     * Sends a sign-in link. The answer is the same whether or not the address has an account, whether the
     * per-address limit was hit or the provider failed: nothing can be learnt about an address from it.
     */
    async requestMagicLink(ctx: { gateway: AuthGateway; client: ClientInfo }, rawEmail: unknown): Promise<FlowResult> {
        const parsed = emailSchema.safeParse(rawEmail);
        if (!parsed.success) return { kind: 'error', code: 'VALIDATION', fields: ['email'] };
        if (!this.allowed(`magic-link:ip:${this.hash(ctx.client.ip)}`, LIMITS.magicLinkPerIp))
            return { kind: 'error', code: 'RATE_LIMITED' };
        const emailHash = this.hash(`email:${parsed.data}`);
        if (!this.allowed(`magic-link:email:${emailHash}`, LIMITS.magicLinkPerEmail)) {
            logger.info('auth.magic_link_throttled', { emailHash });
            return OK;
        }
        try {
            await ctx.gateway.sendMagicLink(parsed.data, `${this.deps.config.appUrl}${AUTH_CALLBACK_PATH}`);
            logger.info('auth.magic_link_sent', { emailHash });
        } catch (error) {
            logger.warn('auth.magic_link_failed', { emailHash, reason: reasonOf(error) });
        }
        return OK;
    }

    /** E-mail link callback. Always ends with a redirect; every refusal goes to the same generic error page. */
    async completeSignIn(
        ctx: AuthContext,
        params: { code?: string | null; tokenHash?: string | null; type?: string | null; next?: string | null }
    ): Promise<FlowResult> {
        const { gateway, session, client } = ctx;
        const ipHash = this.hash(client.ip);
        const refuse = async (reason: string, authUserId?: string): Promise<FlowResult> => {
            logger.warn('auth.sign_in_refused', { reason, ipHash });
            if (authUserId) {
                await this.deps.uow.run((db) =>
                    audit(this.deps, db, SYSTEM, 'auth.sign_in_refused', { type: 'auth_user', id: authUserId }, { metadata: { reason } })
                );
            }
            // Drop any provider session the link may have opened: a refused sign-in leaves nothing behind.
            await gateway?.signOut().catch(() => undefined);
            return { kind: 'redirect', to: SIGN_IN_ERROR_PATH };
        };
        if (!gateway) return refuse('provider_disabled');
        if (!this.allowed(`auth-callback:${ipHash}`, LIMITS.callbackPerIp)) return refuse('rate_limited');
        if ([params.code, params.tokenHash].some((v) => (v?.length ?? 0) > MAX_LINK_PARAM_LENGTH)) return refuse('invalid_request');
        try {
            if (params.code) await gateway.exchangeCode(params.code);
            else if (params.tokenHash && isEmailLinkType(params.type)) await gateway.verifyEmailLink(params.tokenHash, params.type);
            else return refuse('invalid_request');
        } catch (error) {
            return refuse(`link_rejected:${reasonOf(error)}`);
        }

        let identity;
        try {
            identity = await gateway.currentIdentity();
        } catch (error) {
            return refuse(`identity_unavailable:${reasonOf(error)}`);
        }
        if (!identity) return refuse('no_identity');
        const authUserId = identity.authUserId;
        if (!identity.emailConfirmed) return refuse('email_unconfirmed', authUserId);
        const email = identity.email.toLowerCase();
        const { user, sameEmail } = await this.deps.uow.run(async (db) => ({
            user: await db.users.get(authUserId),
            sameEmail: await db.users.findOne({ email })
        }));
        if (user) {
            if (user.status !== 'ACTIVE') return refuse('account_suspended', authUserId);
            await this.openSession(ctx, user, 'email_link');
            return { kind: 'redirect', to: safeRedirectPath(params.next) ?? '/dashboard' };
        }
        // No silent account linking: a profile with this address but another identity (e.g. a demo persona) is refused.
        if (sameEmail) return refuse('email_belongs_to_another_account', authUserId);
        await session.startOnboarding(authUserId);
        return { kind: 'redirect', to: '/onboarding' };
    }

    /** Creates the TrustCargo profile of a verified identity that has none yet, then opens the session. */
    async completeOnboarding(ctx: AuthContext, input: Record<string, unknown>): Promise<FlowResult> {
        const { gateway, session, client } = ctx;
        const pending = await session.pendingOnboarding();
        if (!gateway || !pending) return { kind: 'redirect', to: SIGN_IN_EXPIRED_PATH };
        if (!this.allowed(`onboarding:${this.hash(client.ip)}`, LIMITS.onboardingPerIp)) return { kind: 'error', code: 'RATE_LIMITED' };
        let identity;
        try {
            identity = await gateway.currentIdentity();
        } catch {
            return { kind: 'error', code: 'AUTH_UNAVAILABLE' };
        }
        if (!identity || !identity.emailConfirmed || identity.authUserId !== pending) {
            await session.endOnboarding();
            await gateway.signOut().catch(() => undefined);
            return { kind: 'redirect', to: SIGN_IN_EXPIRED_PATH };
        }
        const parsed = onboardingSchema.safeParse(input);
        if (!parsed.success) {
            return { kind: 'error', code: 'VALIDATION', fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] };
        }
        const email = identity.email.toLowerCase();
        const profile: User = {
            id: identity.authUserId,
            email,
            fullName: parsed.data.fullName,
            phone: parsed.data.phone,
            country: parsed.data.country,
            city: parsed.data.city,
            locale: parsed.data.locale,
            // Staff roles are never self-assigned: only SQL bootstrap or an existing platform admin grants them.
            platformRoles: [],
            kycStatus: 'NOT_STARTED',
            status: 'ACTIVE',
            createdAt: this.deps.clock.now().toISOString(),
            isDemo: false
        };
        let user: User | undefined;
        try {
            user = await this.deps.uow.run(async (db) => {
                // An existing profile with this id or address is never overwritten nor linked.
                if ((await db.users.get(profile.id)) || (await db.users.findOne({ email }))) return undefined;
                const created = await db.users.insert(profile);
                await audit(
                    this.deps,
                    db,
                    actorFor(created),
                    'user.registered',
                    { type: 'user', id: created.id },
                    { metadata: { country: created.country, locale: created.locale, provider: 'supabase' } }
                );
                return created;
            });
        } catch (error) {
            // A concurrent insert is caught by the unique constraints (users.id, lower(email)).
            if (!(error instanceof Error && error.name === 'UniqueViolationError')) throw error;
        }
        if (!user) {
            logger.warn('auth.onboarding_conflict', { ipHash: this.hash(client.ip) });
            return { kind: 'error', code: 'ACCOUNT_EXISTS' };
        }
        await session.endOnboarding();
        await this.openSession(ctx, user, 'onboarding');
        return { kind: 'redirect', to: '/dashboard' };
    }

    /** First MFA step for provider-backed users: verify an existing TOTP factor or enrol a new one. */
    async prepareMfa(ctx: AuthContext, actor: Actor): Promise<FlowResult<MfaStep>> {
        const user = await this.deps.uow.run((db) => db.users.get(actor.userId));
        if (!user) return { kind: 'redirect', to: '/' };
        if (isLocalTotpUser(user)) return { kind: 'ok', data: { mode: 'verify' } };
        const gateway = ctx.gateway;
        if (!gateway) return { kind: 'error', code: 'MFA_UNAVAILABLE' };
        try {
            if (!(await this.providerSessionMatches(gateway, actor))) return this.reauthenticate(ctx);
            const factors = await gateway.listTotpFactors();
            if (factors.some((f) => f.verified)) return { kind: 'ok', data: { mode: 'verify' } };
            if (!this.allowed(`mfa-enrolment:${actor.userId}`, LIMITS.mfaEnrolment)) return { kind: 'error', code: 'RATE_LIMITED' };
            const enrolment = await gateway.enrolTotp();
            await this.deps.uow.run((db) => audit(this.deps, db, actor, 'auth.mfa_enrolment_started', { type: 'user', id: actor.userId }));
            return { kind: 'ok', data: { mode: 'enrol', qrCodeDataUrl: enrolment.qrCodeDataUrl, secret: enrolment.secret } };
        } catch (error) {
            return this.gatewayFailure(ctx, error, 'MFA_UNAVAILABLE');
        }
    }

    /**
     * Step-up challenge. Demo personas: local TOTP. Provider-backed users: challenge + verify with the provider, and the
     * TrustCargo session is only marked MFA-verified once the provider session itself reached AAL2.
     */
    async verifyMfa(ctx: AuthContext, actor: Actor, rawCode: string, rawNext: string): Promise<FlowResult> {
        if (!this.allowed(`mfa:${actor.userId}`, LIMITS.mfa)) return { kind: 'error', code: 'RATE_LIMITED' };
        const user = await this.deps.uow.run((db) => db.users.get(actor.userId));
        const code = rawCode.replace(/\s/g, '');
        const next = safeRedirectPath(rawNext) ?? '/dashboard';
        if (user && isLocalTotpUser(user)) {
            if (!verifyTotp(user.mfaTotpSecret, code)) return this.mfaFailed(actor, 'demo_totp', 'invalid_code');
            return this.mfaPassed(ctx, actor, { method: 'demo_totp' }, next);
        }
        const gateway = ctx.gateway;
        if (!user || !gateway) return this.mfaFailed(actor, 'provider_totp', 'unavailable', 'MFA_UNAVAILABLE');
        if (!/^\d{6}$/.test(code)) return this.mfaFailed(actor, 'provider_totp', 'invalid_code');
        let factor: TotpFactor | undefined;
        try {
            if (!(await this.providerSessionMatches(gateway, actor))) return this.reauthenticate(ctx);
            factor = pickFactor(await gateway.listTotpFactors());
            if (!factor) return this.mfaFailed(actor, 'provider_totp', 'no_factor');
            try {
                await gateway.challengeAndVerifyTotp(factor.id, code);
            } catch (error) {
                if (isAuthGatewayError(error) && error.reason === 'rejected') return this.mfaFailed(actor, 'provider_totp', 'invalid_code');
                throw error;
            }
            if ((await gateway.currentAssuranceLevel()) !== 'aal2') return this.mfaFailed(actor, 'provider_totp', 'aal2_not_reached');
        } catch (error) {
            return this.gatewayFailure(ctx, error, 'AUTH_UNAVAILABLE');
        }
        return this.mfaPassed(ctx, actor, { method: 'provider_totp', enrolment: !factor.verified }, next);
    }

    /** Ends the TrustCargo session and, when configured, the provider session of this device. */
    async signOut(ctx: Pick<AuthContext, 'gateway' | 'session'>): Promise<void> {
        if (ctx.gateway) {
            try {
                await ctx.gateway.signOut();
            } catch (error) {
                logger.warn('auth.provider_sign_out_failed', { reason: reasonOf(error) });
            }
        }
        await ctx.session.end();
    }

    private async openSession(ctx: AuthContext, user: User, method: 'email_link' | 'onboarding') {
        await ctx.session.start(user.id);
        await this.risk.recordSession(user.id, {
            // Honest values only: the profile country (no IP geolocation) and keyed hashes of the user agent and IP.
            country: user.country,
            deviceFingerprintHash: this.hash(ctx.client.userAgent),
            ipHash: this.hash(ctx.client.ip)
        });
        await this.deps.uow.run((db) =>
            audit(this.deps, db, actorFor(user), 'auth.signed_in', { type: 'user', id: user.id }, { metadata: { method } })
        );
    }

    /** The provider session must belong to the very user of the TrustCargo session (no cross-account step-up). */
    private async providerSessionMatches(gateway: AuthGateway, actor: Actor): Promise<boolean> {
        const identity = await gateway.currentIdentity();
        return Boolean(identity && identity.emailConfirmed && identity.authUserId === actor.userId);
    }

    /** Missing, expired or mismatched provider session: both sessions end and the user signs in again. */
    private async reauthenticate(ctx: AuthContext): Promise<FlowResult<never>> {
        await ctx.gateway?.signOut().catch(() => undefined);
        await ctx.session.end();
        return { kind: 'redirect', to: SIGN_IN_EXPIRED_PATH };
    }

    private async gatewayFailure(ctx: AuthContext, error: unknown, rejectedCode: FlowErrorCode): Promise<FlowResult<never>> {
        if (!isAuthGatewayError(error)) throw error;
        logger.warn('auth.provider_request_failed', { reason: reasonOf(error) });
        if (error.reason === 'no_session') return this.reauthenticate(ctx);
        return { kind: 'error', code: error.reason === 'rejected' ? rejectedCode : 'AUTH_UNAVAILABLE' };
    }

    private async mfaFailed(actor: Actor, method: string, reason: string, code: FlowErrorCode = 'MFA_INVALID'): Promise<FlowResult<never>> {
        await this.deps.uow.run((db) =>
            audit(this.deps, db, actor, 'auth.mfa_failed', { type: 'user', id: actor.userId }, { metadata: { method, reason } })
        );
        return { kind: 'error', code };
    }

    private async mfaPassed(ctx: AuthContext, actor: Actor, metadata: Record<string, unknown>, next: string): Promise<FlowResult> {
        await ctx.session.markMfaVerified();
        await this.deps.uow.run((db) => audit(this.deps, db, actor, 'auth.mfa_verified', { type: 'user', id: actor.userId }, { metadata }));
        return { kind: 'redirect', to: next };
    }

    private allowed(key: string, rule: { limit: number; windowMs: number }): boolean {
        return this.rateLimiter.consume(key, rule.limit, rule.windowMs).allowed;
    }

    private hash(value: string): string {
        return pseudonymize(this.deps.config.sessionSecret, value);
    }
}
