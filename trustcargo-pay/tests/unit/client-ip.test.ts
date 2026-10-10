import { describe, expect, it } from 'vitest';
import { clientIp } from '@/server/http/client-ip';

const headers = (values: Record<string, string>) => new Headers(values);

describe('client IP', () => {
    it('takes the right-most X-Forwarded-For entry (appended by the nearest proxy), never a client-supplied one', () => {
        expect(clientIp(headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('203.0.113.7');
        expect(clientIp(headers({ 'x-forwarded-for': '1.1.1.1,2.2.2.2,  198.51.100.4 ' }))).toBe('198.51.100.4');
        expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
        // A spoofed X-Real-IP is ignored unless the platform header is configured.
        expect(clientIp(headers({ 'x-real-ip': '6.6.6.6' }))).toBe('unknown');
        expect(clientIp(headers({}))).toBe('unknown');
    });

    it('rotating a spoofed first entry does not change the identity seen behind a proxy', () => {
        const seen = new Set(Array.from({ length: 20 }, (_, i) => clientIp(headers({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }))));
        expect([...seen]).toEqual(['203.0.113.7']);
    });

    it('uses the configured platform header only, and no client-controlled fallback when it is missing', () => {
        const both = headers({ 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 198.51.100.1' });
        expect(clientIp(both, 'fly-client-ip')).toBe('203.0.113.9');
        expect(clientIp(headers({ 'x-forwarded-for': '6.6.6.6' }), 'fly-client-ip')).toBe('unknown');
    });

    it('bounds the value used as a rate-limit key', () => {
        expect(clientIp(headers({ 'x-forwarded-for': `a, ${'9'.repeat(500)}` }))).toHaveLength(64);
    });
});
