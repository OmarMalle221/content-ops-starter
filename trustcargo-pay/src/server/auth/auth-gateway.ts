import 'server-only';
import { cookies } from 'next/headers';
import { SupabaseAuthGateway } from '@/server/adapters/supabase/supabase-auth';
import type { ServerConfig } from '@/server/config';
import type { AuthGateway } from '@/server/ports/auth-gateway';

/**
 * Request-scoped AuthGateway bound to the current request's cookies. Undefined when AUTH_PROVIDER=demo.
 * Call it from Route Handlers and Server Actions only — never while rendering a Server Component, where a
 * token refresh could not write the rotated refresh token back to the browser.
 */
export async function requestAuthGateway(config: ServerConfig): Promise<AuthGateway | undefined> {
    if (config.auth.provider !== 'supabase' || !config.supabase?.publishableKey) return undefined;
    const store = await cookies();
    return new SupabaseAuthGateway({
        url: config.supabase.url,
        publishableKey: config.supabase.publishableKey,
        secureCookies: process.env.NODE_ENV === 'production',
        cookies: {
            getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
            set: (name, value, o) =>
                store.set(name, value, {
                    httpOnly: o.httpOnly,
                    secure: o.secure,
                    sameSite: o.sameSite,
                    path: o.path,
                    domain: o.domain,
                    maxAge: o.maxAge,
                    expires: o.expires
                })
        }
    });
}
