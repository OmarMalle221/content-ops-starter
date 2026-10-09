import 'server-only';
import { revalidatePath } from 'next/cache';
import type { App } from '@/server/app';
import type { Actor } from '@/server/auth/actor';
import { getActor } from '@/server/auth/session';
import { AppError, isAppError } from '@/server/errors';
import { getApp } from '@/server/instance';
import { logger } from '@/server/logger';
import type { ActionState } from '@/lib/action-state';

/** Normalises any thrown error into a safe, localisable ActionState. */
export function toActionError(error: unknown): ActionState {
    if (isAppError(error)) {
        const d = error.details ?? {};
        const issues = Array.isArray(d.issues) ? (d.issues as { path?: (string | number)[] }[]) : [];
        return {
            ok: false,
            at: Date.now(),
            error: {
                code: error.code,
                message:
                    error.code === 'VALIDATION' || error.code === 'PRECONDITION_FAILED' || error.code === 'CONFLICT'
                        ? error.message
                        : undefined,
                failedGuards: Array.isArray(d.failedGuards) ? (d.failedGuards as string[]) : undefined,
                blockers: Array.isArray(d.blockers) ? (d.blockers as string[]) : undefined,
                fields: issues.map((i) => (i.path ?? []).join('.')).filter(Boolean)
            }
        };
    }
    logger.error('action.unexpected_error', { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, at: Date.now(), error: { code: 'INTERNAL' } };
}

export async function runAction<T>(
    fn: (ctx: { app: App; actor: Actor }) => Promise<T>,
    options: { revalidate?: string[]; rateLimit?: { key: string; limit: number; windowMs: number } } = {}
): Promise<ActionState<T>> {
    try {
        const app = await getApp();
        const actor = await getActor();
        if (!actor) throw new AppError('UNAUTHENTICATED', 'Sign in required');
        if (options.rateLimit) {
            const r = app.rateLimiter.consume(
                `${options.rateLimit.key}:${actor.userId}`,
                options.rateLimit.limit,
                options.rateLimit.windowMs
            );
            if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many requests');
        }
        const data = await fn({ app, actor });
        for (const p of options.revalidate ?? []) revalidatePath(p);
        return { ok: true, data, at: Date.now() };
    } catch (error) {
        // Next.js control-flow errors (redirect/notFound) must propagate.
        if (error && typeof error === 'object' && 'digest' in error && String((error as { digest: unknown }).digest).startsWith('NEXT_'))
            throw error;
        return toActionError(error) as ActionState<T>;
    }
}

export function str(form: FormData, key: string): string {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
}
