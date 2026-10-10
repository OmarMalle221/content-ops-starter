import { describe, expect, it } from 'vitest';
import type { CookieOptions } from '@supabase/ssr';
import { qrCodeToDataUrl, SUPABASE_AUTH_COOKIE, SupabaseAuthGateway } from '@/server/adapters/supabase/supabase-auth';
import { AuthGatewayError } from '@/server/ports/auth-gateway';

// The real @supabase/ssr + auth-js code runs against a fake Auth server (injected fetch) and an in-memory cookie
// jar shared across "requests". Nothing here talks to a real Supabase project.

const SUPABASE_URL = 'https://project-ref.supabase.co';
const PUBLISHABLE = 'sb_publishable_unit_test_only_0123456789';
const USER_ID = '6f1b3a52-0000-4000-8000-0000000000aa';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="#000" width="5" height="5"/></svg>';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(aal: 'aal1' | 'aal2') {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: USER_ID, aal, aud: 'authenticated', role: 'authenticated', session_id: 'sess-1', iat: now, exp: now + 3600 };
    return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.${Buffer.from('fake-signature').toString('base64url')}`;
}

class Jar {
    readonly cookies = new Map<string, { value: string; options: CookieOptions }>();
    getAll() {
        return [...this.cookies].map(([name, c]) => ({ name, value: c.value }));
    }
    set(name: string, value: string, options: CookieOptions) {
        if (options.maxAge === 0) this.cookies.delete(name);
        else this.cookies.set(name, { value, options });
    }
    names() {
        return [...this.cookies.keys()];
    }
}

interface Call {
    method: string;
    url: URL;
    headers: Headers;
    body: Record<string, unknown> | undefined;
}

/** Minimal GoTrue double: one user, one TOTP factor, valid code 123456. */
function fakeAuthServer(options: { failWith?: number } = {}) {
    const calls: Call[] = [];
    let factorVerified = false;
    const user = () => ({
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'Amina.Diallo@Example.test',
        email_confirmed_at: '2026-10-10T10:00:00Z',
        app_metadata: { provider: 'email' },
        user_metadata: {},
        created_at: '2026-10-10T10:00:00Z',
        factors: factorVerified
            ? [
                  {
                      id: 'factor-1',
                      factor_type: 'totp',
                      status: 'verified',
                      created_at: '2026-10-10T10:01:00Z',
                      updated_at: '2026-10-10T10:01:00Z'
                  }
              ]
            : []
    });
    const session = (aal: 'aal1' | 'aal2') => ({
        access_token: jwt(aal),
        refresh_token: `rt-${aal}`,
        expires_in: 3600,
        token_type: 'bearer',
        user: user()
    });
    const reply = (status: number, body?: unknown) =>
        new Response(body === undefined ? null : JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' }
        });
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body });
        if (options.failWith) return reply(options.failWith, { code: 'unexpected_failure', msg: `boom ${PUBLISHABLE}` });
        const route = `${init?.method ?? 'GET'} ${url.pathname}`;
        const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
        switch (route) {
            case 'POST /auth/v1/otp':
                return reply(200, {});
            case 'POST /auth/v1/token':
                return body?.auth_code === 'good-code' && typeof body.code_verifier === 'string' && body.code_verifier.length > 40
                    ? reply(200, session('aal1'))
                    : reply(404, { code: 'flow_state_not_found', msg: 'invalid flow state' });
            case 'GET /auth/v1/user':
                return bearer && bearer.split('.').length === 3 ? reply(200, user()) : reply(401, { code: 'bad_jwt', msg: 'invalid JWT' });
            case 'POST /auth/v1/factors':
                return reply(200, {
                    id: 'factor-1',
                    type: 'totp',
                    totp: { qr_code: SVG, secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' }
                });
            case 'POST /auth/v1/factors/factor-1/challenge':
                return reply(200, { id: 'challenge-1', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
            case 'POST /auth/v1/factors/factor-1/verify':
                if (body?.code !== '123456') return reply(422, { code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
                factorVerified = true;
                return reply(200, session('aal2'));
            case 'POST /auth/v1/logout':
                return reply(204);
            default:
                return reply(404, { code: 'not_found', msg: route });
        }
    };
    return { fetch, calls };
}

function gatewayFor(jar: Jar, fetch: typeof globalThis.fetch) {
    return new SupabaseAuthGateway({ url: SUPABASE_URL, publishableKey: PUBLISHABLE, cookies: jar, secureCookies: true, fetch });
}

describe('Supabase Auth gateway (fake Auth server)', () => {
    it('runs magic link → PKCE callback → identity → TOTP enrolment → AAL2 → sign-out across requests', async () => {
        const jar = new Jar();
        const server = fakeAuthServer();

        // Request 1 (server action): the magic link, with a PKCE verifier kept in an HttpOnly cookie.
        await gatewayFor(jar, server.fetch).sendMagicLink('amina.diallo@example.test', 'https://app.trustcargo.test/auth/callback');
        const otp = server.calls[0]!;
        expect(`${otp.method} ${otp.url.pathname}`).toBe('POST /auth/v1/otp');
        expect(otp.url.searchParams.get('redirect_to')).toBe('https://app.trustcargo.test/auth/callback');
        expect(otp.body).toMatchObject({ email: 'amina.diallo@example.test', create_user: true, code_challenge_method: 's256' });
        expect(otp.headers.get('apikey')).toBe(PUBLISHABLE);
        const verifier = jar.cookies.get(`${SUPABASE_AUTH_COOKIE}-code-verifier`);
        expect(verifier?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });

        // Request 2 (callback route): code exchange, then the identity is fetched from the Auth server.
        const callback = gatewayFor(jar, server.fetch);
        await callback.exchangeCode('good-code');
        const token = server.calls.find((c) => c.url.pathname === '/auth/v1/token')!;
        expect(token.url.searchParams.get('grant_type')).toBe('pkce');
        expect(token.body?.auth_code).toBe('good-code');
        expect(jar.names()).not.toContain(`${SUPABASE_AUTH_COOKIE}-code-verifier`);
        const sessionCookies = [...jar.cookies].filter(([name]) => name.startsWith(SUPABASE_AUTH_COOKIE));
        expect(sessionCookies.length).toBeGreaterThan(0);
        for (const [, c] of sessionCookies) expect(c.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
        expect(await callback.currentIdentity()).toEqual({ authUserId: USER_ID, email: 'amina.diallo@example.test', emailConfirmed: true });

        // Request 3 (MFA server actions): enrolment, wrong code, right code, AAL2 validated by the server.
        const mfa = gatewayFor(jar, server.fetch);
        expect(await mfa.listTotpFactors()).toEqual([]);
        const enrolment = await mfa.enrolTotp();
        expect(enrolment.factorId).toBe('factor-1');
        expect(enrolment.secret).toBe('JBSWY3DPEHPK3PXP');
        expect(enrolment.qrCodeDataUrl).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
        const wrong = await mfa.challengeAndVerifyTotp('factor-1', '000000').catch((e: unknown) => e);
        expect(wrong).toBeInstanceOf(AuthGatewayError);
        expect(wrong).toMatchObject({ reason: 'rejected', providerCode: 'mfa_verification_failed' });
        expect(await mfa.currentAssuranceLevel()).toBe('aal1');
        await mfa.challengeAndVerifyTotp('factor-1', '123456');
        const before = server.calls.length;
        expect(await mfa.currentAssuranceLevel()).toBe('aal2');
        const validation = server.calls.slice(before).find((c) => c.url.pathname === '/auth/v1/user');
        // The level comes from the token that the Auth server was asked to validate (GET /user), not from the cookie alone.
        const bearer = validation?.headers.get('authorization')?.replace('Bearer ', '') ?? '';
        expect(JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString())).toMatchObject({ sub: USER_ID, aal: 'aal2' });

        // A later request sees the AAL2 session from the cookies.
        expect(await gatewayFor(jar, server.fetch).listTotpFactors()).toEqual([
            { id: 'factor-1', verified: true, createdAt: '2026-10-10T10:01:00Z' }
        ]);

        // Request 4 (logout): local sign-out clears the provider session cookies.
        await gatewayFor(jar, server.fetch).signOut();
        const logout = server.calls.at(-1)!;
        expect(`${logout.method} ${logout.url.pathname}`).toBe('POST /auth/v1/logout');
        expect(logout.url.searchParams.get('scope')).toBe('local');
        expect(jar.names().filter((n) => n.startsWith(SUPABASE_AUTH_COOKIE))).toEqual([]);
    });

    it('has no identity without a session cookie, and makes no request for it', async () => {
        const server = fakeAuthServer();
        const gateway = gatewayFor(new Jar(), server.fetch);
        expect(await gateway.currentIdentity()).toBeUndefined();
        expect(await gateway.currentAssuranceLevel()).toBeUndefined();
        expect(server.calls).toEqual([]);
    });

    it('maps a rejected code exchange and provider outages to sanitized gateway errors', async () => {
        const rejected = await gatewayFor(new Jar(), fakeAuthServer().fetch)
            .exchangeCode('bad-code')
            .catch((e: unknown) => e);
        expect(rejected).toMatchObject({ name: 'AuthGatewayError', reason: 'rejected' });

        const down = await gatewayFor(new Jar(), fakeAuthServer({ failWith: 503 }).fetch)
            .sendMagicLink('a@example.test', 'https://app.trustcargo.test/auth/callback')
            .catch((e: unknown) => e);
        expect(down).toMatchObject({ name: 'AuthGatewayError', reason: 'unavailable' });
        expect((down as Error).message).not.toContain(PUBLISHABLE);
        expect((down as Error).message).not.toContain('boom');
    });

    it('re-encodes the provider QR code as a base64 SVG data URL and ignores anything else', () => {
        expect(qrCodeToDataUrl(`data:image/svg+xml;utf-8,${SVG}`)).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
        expect(qrCodeToDataUrl(SVG)).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
        expect(qrCodeToDataUrl('javascript:alert(1)')).toBeUndefined();
        expect(qrCodeToDataUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    });
});
