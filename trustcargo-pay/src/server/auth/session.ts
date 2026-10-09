import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { PlatformRole } from '@/domain/model';
import { getApp } from '@/server/instance';
import { hmacHex, randomToken, safeEqualHex } from '@/server/security/crypto';
import type { Actor } from './actor';
import { hasRole, mfaIsRecent } from './actor';

export const SESSION_COOKIE = 'tc_session';
const SESSION_TTL_MS = 12 * 3_600_000;

interface SessionPayload {
    sid: string;
    uid: string;
    iat: number;
    mfa?: number;
}

function encode(secret: string, payload: SessionPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${hmacHex(secret, `session:${body}`)}`;
}

function decode(secret: string, value: string | undefined): SessionPayload | undefined {
    if (!value) return undefined;
    const [body, sig] = value.split('.');
    if (!body || !sig || !safeEqualHex(hmacHex(secret, `session:${body}`), sig)) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
        if (Date.now() - payload.iat > SESSION_TTL_MS) return undefined;
        return payload;
    } catch {
        return undefined;
    }
}

async function writeCookie(payload: SessionPayload) {
    const app = await getApp();
    (await cookies()).set(SESSION_COOKIE, encode(app.config.sessionSecret, payload), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000
    });
}

export async function startSession(userId: string) {
    await writeCookie({ sid: randomToken(12), uid: userId, iat: Date.now() });
}

export async function markMfaVerified() {
    const app = await getApp();
    const current = decode(app.config.sessionSecret, (await cookies()).get(SESSION_COOKIE)?.value);
    if (!current) return;
    await writeCookie({ ...current, mfa: Date.now() });
}

export async function endSession() {
    (await cookies()).delete(SESSION_COOKIE);
}

/** Resolves the actor from the signed cookie. Roles and status always come from the database. */
export async function getActor(): Promise<Actor | undefined> {
    const app = await getApp();
    const payload = decode(app.config.sessionSecret, (await cookies()).get(SESSION_COOKIE)?.value);
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
    const h = await headers();
    return {
        ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? 'unknown',
        userAgent: h.get('user-agent') ?? 'unknown'
    };
}
