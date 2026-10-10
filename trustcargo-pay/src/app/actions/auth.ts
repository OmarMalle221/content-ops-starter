'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LOCALE_COOKIE } from '@/i18n';
import { PERSONAS } from '@/server/demo/personas';
import { requestAuthGateway } from '@/server/auth/auth-gateway';
import { clientFingerprint, endSession, getActor, sessionControl, startSession } from '@/server/auth/session';
import { getApp, resetDemo } from '@/server/instance';
import { pseudonymize } from '@/server/security/crypto';
import { safeRedirectPath } from '@/server/security/redirect';
import type { AuthContext, FlowResult, MfaStep } from '@/server/services/account-service';
import type { ActionState } from '@/lib/action-state';
import { hasRole } from '@/server/auth/actor';
import { str, toActionError } from './_run';

/** Demo-only sign-in as a fictitious persona. Disabled outside demo mode. */
export async function loginAsPersona(_: ActionState, form: FormData): Promise<ActionState> {
    const app = await getApp();
    if (!app.config.personaLogin) return { ok: false, error: { code: 'FORBIDDEN' } };
    const fp = await clientFingerprint();
    const limit = app.rateLimiter.consume(`login:${pseudonymize(app.config.sessionSecret, fp.ip)}`, 30, 60_000);
    if (!limit.allowed) return { ok: false, error: { code: 'RATE_LIMITED' } };
    const persona = PERSONAS.find((p) => p.key === str(form, 'persona'));
    if (!persona) return { ok: false, error: { code: 'NOT_FOUND' } };
    const user = await app.deps.uow.run((db) => db.users.findOne({ email: persona.email }));
    if (!user) return { ok: false, error: { code: 'NOT_FOUND' } };
    await startSession(user.id);
    await app.risk.recordSession(user.id, {
        country: persona.country,
        // Demo only: one person plays every persona from the same browser. Scoping the device
        // fingerprint per persona keeps the LINKED_ACCOUNTS rule meaningful for real sign-ins
        // without flagging every demo transaction as self-dealing.
        deviceFingerprintHash: pseudonymize(app.config.sessionSecret, `${fp.userAgent}|demo-persona:${persona.key}`),
        ipHash: pseudonymize(app.config.sessionSecret, fp.ip)
    });
    (await cookies()).set(LOCALE_COOKIE, (await cookies()).get(LOCALE_COOKIE)?.value ?? persona.locale, { path: '/', sameSite: 'lax' });
    redirect(user.platformRoles.length ? '/admin' : '/dashboard');
}

async function authContext(): Promise<{ app: Awaited<ReturnType<typeof getApp>>; ctx: AuthContext }> {
    const app = await getApp();
    return { app, ctx: { gateway: await requestAuthGateway(app.config), session: sessionControl, client: await clientFingerprint() } };
}

/** Runs an account flow: redirects are thrown outside the try/catch, errors become a safe ActionState. */
async function runFlow<T>(fn: () => Promise<FlowResult<T>>): Promise<ActionState<T>> {
    let result: FlowResult<T>;
    try {
        result = await fn();
    } catch (error) {
        return toActionError(error) as ActionState<T>;
    }
    if (result.kind === 'redirect') redirect(result.to);
    if (result.kind === 'error') return { ok: false, at: Date.now(), error: { code: result.code, fields: result.fields } };
    return { ok: true, at: Date.now(), data: result.data };
}

/** Supabase Auth: sends a magic link. Always the same confirmation, whatever the address. */
export async function requestMagicLink(_: ActionState, form: FormData): Promise<ActionState> {
    const { app, ctx } = await authContext();
    const gateway = ctx.gateway;
    if (!gateway) return { ok: false, at: Date.now(), error: { code: 'FORBIDDEN' } };
    return runFlow(() => app.accounts.requestMagicLink({ gateway, client: ctx.client }, str(form, 'email')));
}

/** Creates the TrustCargo profile of a verified Supabase identity. The e-mail address is never read from the form. */
export async function completeOnboarding(_: ActionState, form: FormData): Promise<ActionState> {
    const { app, ctx } = await authContext();
    const locale = str(form, 'locale');
    const input = {
        fullName: str(form, 'fullName'),
        country: str(form, 'country'),
        city: str(form, 'city'),
        phone: str(form, 'phone'),
        locale
    };
    return runFlow(async () => {
        const result = await app.accounts.completeOnboarding(ctx, input);
        if (result.kind === 'redirect' && (locale === 'fr' || locale === 'en')) {
            (await cookies()).set(LOCALE_COOKIE, locale, { path: '/', sameSite: 'lax', maxAge: 365 * 86_400 });
        }
        return result;
    });
}

export async function logout() {
    const { app, ctx } = await authContext();
    await app.accounts.signOut(ctx);
    redirect('/');
}

/** Supabase MFA, step 1: returns whether to verify an existing TOTP factor or to enrol one (QR code + secret). */
export async function prepareMfa(_: ActionState): Promise<ActionState<MfaStep>> {
    const { app, ctx } = await authContext();
    const actor = await getActor();
    if (!actor) return { ok: false, at: Date.now(), error: { code: 'UNAUTHENTICATED' } };
    return runFlow(() => app.accounts.prepareMfa(ctx, actor));
}

/** Step-up MFA: local TOTP for demo personas, Supabase TOTP (AAL2 required) for real users. */
export async function verifyMfa(_: ActionState, form: FormData): Promise<ActionState> {
    const { app, ctx } = await authContext();
    const actor = await getActor();
    if (!actor) return { ok: false, error: { code: 'UNAUTHENTICATED' } };
    return runFlow(() => app.accounts.verifyMfa(ctx, actor, str(form, 'code'), str(form, 'next')));
}

export async function setLocale(form: FormData) {
    const locale = str(form, 'locale') === 'en' ? 'en' : 'fr';
    (await cookies()).set(LOCALE_COOKIE, locale, { path: '/', sameSite: 'lax', maxAge: 365 * 86_400 });
    // Return to the page the user was on (same-origin referer only), else to the provided fallback.
    const h = await headers();
    let back = str(form, 'back');
    try {
        const ref = new URL(h.get('referer') ?? '');
        if (ref.host === h.get('host')) back = ref.pathname + ref.search;
    } catch {
        /* no referer */
    }
    redirect(safeRedirectPath(back) ?? '/');
}

export async function resetDemoAction() {
    const app = await getApp();
    const actor = await getActor();
    if (!actor || app.config.mode !== 'demo' || !hasRole(actor, 'platform_admin')) redirect('/');
    await resetDemo();
    await endSession();
    redirect('/');
}
