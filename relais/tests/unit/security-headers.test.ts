import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_SUPABASE_ORIGIN, securityHeaders } from '../../security-headers';

describe('en-têtes de sécurité', () => {
    const toml = readFileSync('netlify.toml', 'utf8');

    it('netlify.toml reprend exactement les en-têtes de security-headers.ts', () => {
        for (const [name, value] of Object.entries(securityHeaders(PRODUCTION_SUPABASE_ORIGIN))) {
            expect(toml).toContain(`${name} = "${value}"`);
        }
    });

    it('la CSP n’autorise aucun script ni style externe ou en ligne', () => {
        const csp = securityHeaders(PRODUCTION_SUPABASE_ORIGIN)['Content-Security-Policy'];
        expect(csp).toContain("script-src 'self';");
        expect(csp).toContain("style-src 'self';");
        expect(csp).not.toContain('unsafe-inline');
        expect(csp).not.toContain('unsafe-eval');
        expect(csp).toContain("frame-ancestors 'none'");
    });
});
