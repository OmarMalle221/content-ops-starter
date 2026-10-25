// En-têtes de sécurité de Relais : une seule définition, utilisée par `vite preview` (tests de bout en
// bout, qui s'exécutent donc sous la même CSP) et recopiée dans netlify.toml (vérifié par un test).

/** Politique de sécurité du contenu : aucun script, style ou police externe ; seul Supabase est joignable. */
export function contentSecurityPolicy(supabaseOrigin: string): string {
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self' ${supabaseOrigin}`,
        "manifest-src 'self'",
        "worker-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'"
    ].join('; ');
}

export function securityHeaders(supabaseOrigin: string): Record<string, string> {
    return {
        'Content-Security-Policy': contentSecurityPolicy(supabaseOrigin),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
        'Cross-Origin-Opener-Policy': 'same-origin'
    };
}

/** Origine Supabase en production (projet en région ca-central-1). */
export const PRODUCTION_SUPABASE_ORIGIN = 'https://*.supabase.co';
