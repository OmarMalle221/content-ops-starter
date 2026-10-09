'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LOCALE_COOKIE } from '@/i18n';
import { PERSONAS } from '@/server/demo/personas';
import { clientFingerprint, endSession, getActor, markMfaVerified, startSession } from '@/server/auth/session';
import { getApp, resetDemo } from '@/server/instance';
import { pseudonymize } from '@/server/security/crypto';
import { verifyTotp } from '@/server/security/totp';
import type { ActionState } from '@/lib/action-state';
import { hasRole } from '@/server/auth/actor';
import { str } from './_run';

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

export async function logout() {
    await endSession();
    redirect('/');
}

export async function verifyMfa(_: ActionState, form: FormData): Promise<ActionState> {
    const app = await getApp();
    const actor = await getActor();
    if (!actor) return { ok: false, error: { code: 'UNAUTHENTICATED' } };
    const limit = app.rateLimiter.consume(`mfa:${actor.userId}`, 5, 5 * 60_000);
    if (!limit.allowed) return { ok: false, error: { code: 'RATE_LIMITED' } };
    const user = await app.deps.uow.run((db) => db.users.get(actor.userId));
    const code = str(form, 'code').replace(/\s/g, '');
    if (!user?.mfaTotpSecret || !verifyTotp(user.mfaTotpSecret, code)) {
        await app.deps.uow.run((db) =>
            import('@/server/services/context').then(({ audit }) =>
                audit(app.deps, db, actor, 'auth.mfa_failed', { type: 'user', id: actor.userId })
            )
        );
        return { ok: false, error: { code: 'MFA_INVALID' } };
    }
    await markMfaVerified();
    await app.deps.uow.run((db) =>
        import('@/server/services/context').then(({ audit }) =>
            audit(app.deps, db, actor, 'auth.mfa_verified', { type: 'user', id: actor.userId })
        )
    );
    const next = str(form, 'next');
    redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
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
    redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/');
}

export async function resetDemoAction() {
    const app = await getApp();
    const actor = await getActor();
    if (!actor || app.config.mode !== 'demo' || !hasRole(actor, 'platform_admin')) redirect('/');
    await resetDemo();
    await endSession();
    redirect('/');
}
