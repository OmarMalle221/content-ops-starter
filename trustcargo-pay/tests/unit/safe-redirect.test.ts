import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '@/server/security/redirect';

describe('safeRedirectPath', () => {
    it('keeps same-origin relative paths (normalised)', () => {
        expect(safeRedirectPath('/dashboard')).toBe('/dashboard');
        expect(safeRedirectPath('/transactions/abc?tab=documents')).toBe('/transactions/abc?tab=documents');
        expect(safeRedirectPath('/admin/disputes#d1')).toBe('/admin/disputes#d1');
        expect(safeRedirectPath('/a/../admin')).toBe('/admin');
    });

    it.each([
        ['empty', ''],
        ['relative without slash', 'dashboard'],
        ['protocol-relative', '//evil.example'],
        ['triple slash', '///evil.example'],
        ['slash-backslash', '/\\evil.example'],
        ['double backslash', '\\\\evil.example'],
        ['backslash later in the path', '/foo\\..\\..\\evil'],
        ['absolute https URL', 'https://evil.example/dashboard'],
        ['scheme without slashes', 'http:/evil.example'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['data scheme', 'data:text/html,<script>alert(1)</script>'],
        ['leading space', ' //evil.example'],
        ['encoded slashes', '/%2F%2Fevil.example'],
        ['encoded slashes without leading slash', '%2F%2Fevil.example'],
        ['encoded backslash', '/%5Cevil.example'],
        ['encoded backslash, lower case', '/%5cevil.example'],
        ['double-encoded slashes', '/%252F%252Fevil.example'],
        ['four encoding layers', '/%2525252F%2525252Fevil.example'],
        ['tab between slashes', '/\t/evil.example'],
        ['newline between slashes', '/\n/evil.example'],
        ['encoded tab', '/%09/evil.example'],
        ['header injection', '/%0d%0aSet-Cookie:%20x=y'],
        ['dot segment collapsing into //', '/.//evil.example'],
        ['malformed encoding', '/%E0%A4%A'],
        ['too long', `/${'a'.repeat(2000)}`]
    ])('rejects %s', (_, input) => {
        expect(safeRedirectPath(input)).toBeUndefined();
    });

    it('rejects non-string input', () => {
        for (const input of [undefined, null, 42, ['/dashboard'], { toString: () => '/dashboard' }])
            expect(safeRedirectPath(input)).toBeUndefined();
    });
});
