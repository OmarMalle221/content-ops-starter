import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { PlatformRole } from '@/domain/model';
import { clientIp } from '@/server/http/client-ip';
import { getApp } from '@/server/instance';
import { hmacHex, randomToken, safeEqualHex } from '@/server/security/crypto';
import type { SessionControl } from '@/server/services/account-service';
import type { Actor } from './actor';
import { hasRole, mfaIsRecent } from './actor';

export const SESSION_COOKIE = 'tc_session';
const SESSION_TTL_MS = 12 * 3_600_000;
/** Signed marker set by the e-mail link callback for a verified identity that has no TrustCargo profile yet. */
export const ONBOARDING_COOKIE = 'tc_onboarding';
const ONBOARDING_TTL_MS = 30 * 60_000;

interface SessionPayload {
    sid: string;
    uid: string;
    iat: number;
    mfa?: number;
}

interface OnboardingPayload {
    uid: string;
    iat: number;
}

/** The HMAC context includes the purpose, so a cookie of one kind can never be replayed as another. */
type CookiePurpose = 'session' | 'onboarding';

function encode(secret: string, purpose: CookiePurpose, payload: SessionPayload | OnboardingPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${hmacHex(secret, `${purpose}:${body}`)}`;
}

function decode<T extends { iat: number }>(
    secret: string,
    purpose: CookiePurpose,
    value: string | undefined,
    ttlMs: number
): T | undefined {
    if (!value) return undefined;
    const [body, sig] = value.split('.');
    if (!body || !sig || !safeEqualHex(hmacHex(secret, `${purpose}:${body}`), sig)) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
        if (Date.now() - payload.iat > ttlMs) return undefined;
        return payload;
    } catch {
        return undefined;
    }
}

const cookieFlags = (maxAgeMs: number) => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeMs / 1000
});

async function readSession(secret: string): Promise<SessionPayload | undefined> {
    return decode<SessionPayload>(secret, 'session', (await cookies()).get(SESSION_COOKIE)?.value, SESSION_TTL_MS);
}

async function writeCookie(payload: SessionPayload) {
    const app = await getApp();
    (await cookies()).set(SESSION_COOKIE, encode(app.config.sessionSecret, 'session', payload), cookieFlags(SESSION_TTL_MS));
}

export async function startSession(userId: string) {
    await writeCookie({ sid: randomToken(12), uid: userId, iat: Date.now() });
}

export async function markMfaVerified() {
    const app = await getApp();
    const current = await readSession(app.config.sessionSecret);
    if (!current) return;
    await writeCookie({ ...current, mfa: Date.now() });
}

export async function endSession() {
    (await cookies()).delete(SESSION_COOKIE);
}

export async function startOnboarding(authUserId: string) {
    const app = await getApp();
    const payload: OnboardingPayload = { uid: authUserId, iat: Date.now() };
    (await cookies()).set(ONBOARDING_COOKIE, encode(app.config.sessionSecret, 'onboarding', payload), cookieFlags(ONBOARDING_TTL_MS));
}

/** Auth user id of a pending onboarding (no provider call: safe to use while rendering a page). */
export async function pendingOnboarding(): Promise<string | undefined> {
    const app = await getApp();
    const value = (await cookies()).get(ONBOARDING_COOKIE)?.value;
    return decode<OnboardingPayload>(app.config.sessionSecret, 'onboarding', value, ONBOARDING_TTL_MS)?.uid;
}

export async function endOnboarding() {
    (await cookies()).delete(ONBOARDING_COOKIE);
}

/** Cookie side effects handed to AccountService (Route Handlers and Server Actions only). */
export const sessionControl: SessionControl = {
    currentUserId: async () => (await readSession((await getApp()).config.sessionSecret))?.uid,
    start: startSession,
    markMfaVerified,
    end: endSession,
    startOnboarding,
    pendingOnboarding,
    endOnboarding
};

/** Resolves the actor from the signed cookie. Roles and status always come from the database. */
export async function getActor(): Promise<Actor | undefined> {
    const app = await getApp();
    const payload = await readSession(app.config.sessionSecret);
    if (!payload) return undefined;
    const user = await app.deps.uow.run((db) => db.users.get(payload.uid));
    if (!user || user.status !== 'ACTIVE') return undefined;
    return {
        kind: 'USER',
        userId: user.id,
        email: user.email,
        platformRoles: user.platformRoles,
        mfaVerifiedAt: payload.mfa ? new Date(payload.mfa).toISOString() : undefined,
        sessionId: payload.sid
    };
}

export async function requireActor(): Promise<Actor> {
    const actor = await getActor();
    if (!actor) redirect('/');
    return actor;
}

/** Back-office pages: a staff role AND a recent MFA challenge. */
export async function requireStaff(roles: PlatformRole[], next: string): Promise<Actor> {
    const actor = await requireActor();
    if (!hasRole(actor, ...roles)) redirect('/dashboard');
    const app = await getApp();
    const settings = await app.deps.uow.run(async (db) => (await db.securitySettings.get('default'))!);
    if (!mfaIsRecent(actor, settings.adminMfaMaxAgeMinutes, new Date())) redirect(`/mfa?next=${encodeURIComponent(next)}`);
    return actor;
}

export async function clientFingerprint(): Promise<{ ip: string; userAgent: string }> {
    const app = await getApp();
    const h = await headers();
    return { ip: clientIp(h, app.config.clientIpHeader), userAgent: h.get('user-agent') ?? 'unknown' };
}
