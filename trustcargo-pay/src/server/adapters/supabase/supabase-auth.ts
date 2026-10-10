/**
 * Supabase Auth implementation of `AuthGateway`, built on @supabase/ssr's server client.
 *
 * - Request-scoped: one instance per request, bound to that request's cookies (see src/server/auth/auth-gateway.ts).
 * - Uses the publishable key only; the Supabase session lives in HttpOnly cookies that browser code cannot read.
 * - Must only be used from Route Handlers and Server Actions: a token refresh writes cookies, which a Server
 *   Component render cannot do (the rotated refresh token would be lost).
 * - Provider error messages are never propagated; only a reason and a sanitised error code.
 */
import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { isAuthRetryableFetchError, isAuthSessionMissingError, type AuthError, type Factor } from '@supabase/supabase-js';
import {
    AuthGatewayError,
    type AssuranceLevel,
    type AuthGateway,
    type EmailLinkType,
    type TotpEnrolment,
    type TotpFactor,
    type VerifiedIdentity
} from '@/server/ports/auth-gateway';
import { DEFAULT_SUPABASE_TIMEOUT_MS, fetchWithTimeout } from './fetch';

/** Dedicated cookie name, so a different app on the same host (e.g. another localhost port) never shares it. */
export const SUPABASE_AUTH_COOKIE = 'tc-sb-auth';
const TOTP_ISSUER = 'TrustCargo Pay';

export interface CookieJar {
    getAll(): { name: string; value: string }[];
    set(name: string, value: string, options: CookieOptions): void;
}

export interface SupabaseAuthOptions {
    url: string;
    publishableKey: string;
    cookies: CookieJar;
    /** `Secure` attribute on the session cookies (true in production). */
    secureCookies: boolean;
    timeoutMs?: number;
    /** Injected in tests; defaults to the global fetch. */
    fetch?: typeof fetch;
}

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const NO_SESSION_CODES = new Set([
    'session_not_found',
    'session_expired',
    'refresh_token_not_found',
    'refresh_token_already_used',
    'bad_jwt'
]);

function toGatewayError(error: AuthError): AuthGatewayError {
    const code = typeof error.code === 'string' && SAFE_CODE.test(error.code) ? error.code : undefined;
    if (isAuthRetryableFetchError(error) || error.name === 'AuthUnknownError') return new AuthGatewayError('unavailable', code);
    if (isAuthSessionMissingError(error) || (code && NO_SESSION_CODES.has(code))) return new AuthGatewayError('no_session', code);
    if (error.status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
        return new AuthGatewayError('rate_limited', code);
    }
    return new AuthGatewayError('rejected', code);
}

/** auth-js prefixes the raw SVG with `data:image/svg+xml;utf-8,`; re-encode it in base64 so `#` or quotes cannot truncate the URL. */
export function qrCodeToDataUrl(qrCode: string): string | undefined {
    const prefix = 'data:image/svg+xml;utf-8,';
    const svg = qrCode.startsWith(prefix) ? qrCode.slice(prefix.length) : qrCode;
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return undefined;
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

export class SupabaseAuthGateway implements AuthGateway {
    private readonly client: ReturnType<typeof createServerClient>;

    constructor(options: SupabaseAuthOptions) {
        const cookieOptions: CookieOptions & { name: string } = {
            name: SUPABASE_AUTH_COOKIE,
            httpOnly: true,
            secure: options.secureCookies,
            sameSite: 'lax',
            path: '/'
        };
        this.client = createServerClient(options.url, options.publishableKey, {
            cookieOptions,
            cookies: {
                getAll: () => options.cookies.getAll(),
                setAll: (cookies) => {
                    for (const c of cookies) options.cookies.set(c.name, c.value, c.options);
                }
            },
            global: { fetch: fetchWithTimeout(options.timeoutMs ?? DEFAULT_SUPABASE_TIMEOUT_MS, options.fetch) }
        });
    }

    async sendMagicLink(email: string, redirectTo: string): Promise<void> {
        const { error } = await this.client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: true } });
        if (error) throw toGatewayError(error);
    }

    async exchangeCode(code: string): Promise<void> {
        const { error } = await this.client.auth.exchangeCodeForSession(code);
        if (error) throw toGatewayError(error);
    }

    async verifyEmailLink(tokenHash: string, type: EmailLinkType): Promise<void> {
        const { error } = await this.client.auth.verifyOtp({ token_hash: tokenHash, type });
        if (error) throw toGatewayError(error);
    }

    async currentIdentity(): Promise<VerifiedIdentity | undefined> {
        // getUser() asks the Auth server to validate the access token (a cookie alone is never trusted).
        const { data, error } = await this.client.auth.getUser();
        if (error) {
            const mapped = toGatewayError(error);
            if (mapped.reason === 'no_session' || mapped.reason === 'rejected') return undefined;
            throw mapped;
        }
        if (!data.user.email) return undefined;
        return { authUserId: data.user.id, email: data.user.email.toLowerCase(), emailConfirmed: Boolean(data.user.email_confirmed_at) };
    }

    async listTotpFactors(): Promise<TotpFactor[]> {
        const { data, error } = await this.client.auth.mfa.listFactors();
        if (error) throw toGatewayError(error);
        const factors: Factor[] = data.all;
        return factors
            .filter((f) => f.factor_type === 'totp')
            .map((f) => ({ id: f.id, verified: f.status === 'verified', createdAt: f.created_at }));
    }

    async enrolTotp(): Promise<TotpEnrolment> {
        const { data, error } = await this.client.auth.mfa.enroll({ factorType: 'totp', issuer: TOTP_ISSUER });
        if (error) throw toGatewayError(error);
        return { factorId: data.id, qrCodeDataUrl: qrCodeToDataUrl(data.totp.qr_code), secret: data.totp.secret };
    }

    async challengeAndVerifyTotp(factorId: string, code: string): Promise<void> {
        const { error } = await this.client.auth.mfa.challengeAndVerify({ factorId, code });
        if (error) throw toGatewayError(error);
    }

    async currentAssuranceLevel(): Promise<AssuranceLevel | undefined> {
        const { data: sessionData, error: sessionError } = await this.client.auth.getSession();
        if (sessionError) throw toGatewayError(sessionError);
        if (!sessionData.session) return undefined;
        // Passing the JWT makes auth-js validate it with the Auth server (GET /user) instead of trusting the cookie copy.
        const { data, error } = await this.client.auth.mfa.getAuthenticatorAssuranceLevel(sessionData.session.access_token);
        if (error) {
            const mapped = toGatewayError(error);
            if (mapped.reason === 'no_session' || mapped.reason === 'rejected') return undefined;
            throw mapped;
        }
        return data.currentLevel === 'aal2' ? 'aal2' : data.currentLevel === 'aal1' ? 'aal1' : undefined;
    }

    async signOut(): Promise<void> {
        const { error } = await this.client.auth.signOut({ scope: 'local' });
        if (error) throw toGatewayError(error);
    }
}
