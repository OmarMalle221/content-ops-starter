/**
 * fetch wrapper passed to supabase-js as `global.fetch`: every Storage/Auth request gets a hard timeout so a
 * slow or unreachable Supabase project cannot hold a request (or a server action) open indefinitely.
 * An AbortSignal already set by the caller is still honoured.
 */
export const DEFAULT_SUPABASE_TIMEOUT_MS = 10_000;

export function fetchWithTimeout(timeoutMs: number, base: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
    return (input, init) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        return base(input, { ...init, signal });
    };
}
