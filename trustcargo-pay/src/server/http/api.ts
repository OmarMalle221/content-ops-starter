import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import type { App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { getActor } from '@/server/auth/session';
import { clientIp } from '@/server/http/client-ip';
import { AppError, isAppError } from '@/server/errors';
import { getApp } from '@/server/instance';
import { logger } from '@/server/logger';
import { pseudonymize, randomToken } from '@/server/security/crypto';

const MAX_JSON_BYTES = 256 * 1024;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
    const body = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    return new NextResponse(body, {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
    });
}

export function problem(error: unknown, requestId: string) {
    if (isAppError(error)) {
        const details = error.details
            ? Object.fromEntries(
                  Object.entries(error.details).filter(([k]) => ['failedGuards', 'blockers', 'issues', 'status', 'transition'].includes(k))
              )
            : undefined;
        return json({ error: { code: error.code, message: error.message, details, requestId } }, error.status);
    }
    logger.error('api.unexpected_error', { requestId, error: error instanceof Error ? error.message : String(error) });
    return json({ error: { code: 'INTERNAL', message: 'Unexpected error', requestId } }, 500);
}

/**
 * CSRF defence for cookie-authenticated mutations: the request must come from our own origin.
 * (Server Actions get the equivalent check from Next.js.)
 */
function sameOrigin(req: NextRequest): boolean {
    const origin = req.headers.get('origin');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (origin) {
        try {
            return new URL(origin).host === host;
        } catch {
            return false;
        }
    }
    return req.headers.get('sec-fetch-site') === 'same-origin';
}

export async function readJson<T = unknown>(req: NextRequest): Promise<T> {
    const text = await req.text();
    if (text.length > MAX_JSON_BYTES) throw new AppError('VALIDATION', 'Payload too large');
    if (!text) return {} as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new AppError('VALIDATION', 'Malformed JSON');
    }
}

export function apiRoute<P>(
    handler: (ctx: { req: NextRequest; app: App; actor: Actor; params: P; requestId: string }) => Promise<Response>,
    options: { rateLimit?: { limit: number; windowMs: number } } = {}
) {
    return async (req: NextRequest, context: { params: Promise<P> }) => {
        const requestId = randomToken(8);
        try {
            const app = await getApp();
            const actor = await getActor();
            if (!actor) throw new AppError('UNAUTHENTICATED', 'Authentication required');
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                if (!sameOrigin(req)) throw new AppError('FORBIDDEN', 'Cross-origin request rejected');
                const ct = req.headers.get('content-type') ?? '';
                if (!ct.startsWith('application/json')) throw new AppError('VALIDATION', 'Content-Type must be application/json');
            }
            const rl = options.rateLimit ?? { limit: 120, windowMs: 60_000 };
            const ip = clientIp(req.headers, app.config.clientIpHeader);
            const limited = app.rateLimiter.consume(
                `api:${actor.userId}:${pseudonymize(app.config.sessionSecret, ip)}:${req.nextUrl.pathname}`,
                rl.limit,
                rl.windowMs
            );
            if (!limited.allowed) throw new AppError('RATE_LIMITED', 'Too many requests');
            const response = await handler({ req, app, actor, params: await context.params, requestId });
            response.headers.set('x-request-id', requestId);
            return response;
        } catch (error) {
            return problem(error, requestId);
        }
    };
}
