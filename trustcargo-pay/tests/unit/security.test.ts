import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '@/server/security/webhook-signature';
import { signDocumentUrl, verifyDocumentUrl } from '@/server/security/signed-url';
import { totp, verifyTotp } from '@/server/security/totp';
import { InMemoryRateLimiter } from '@/server/security/rate-limit';
import { canonicalJson } from '@/domain/canonical';

describe('webhook signatures', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'evt_1', type: 'funds.confirmed' });
    const now = 1_800_000_000;

    it('accepts a valid signature', () => {
        expect(verifySignature(secret, body, signPayload(secret, body, now), now)).toEqual({ ok: true, timestamp: now });
    });

    it('rejects tampered bodies, wrong secrets, missing/malformed headers and stale timestamps', () => {
        const header = signPayload(secret, body, now);
        expect(verifySignature(secret, body.replace('funds', 'fund'), header, now)).toEqual({ ok: false, reason: 'MISMATCH' });
        expect(verifySignature('other', body, header, now)).toEqual({ ok: false, reason: 'MISMATCH' });
        expect(verifySignature(secret, body, null, now)).toEqual({ ok: false, reason: 'MISSING' });
        expect(verifySignature(secret, body, 'garbage', now)).toEqual({ ok: false, reason: 'MALFORMED' });
        expect(verifySignature(secret, body, header, now + 301)).toEqual({ ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
    });
});

describe('signed document URLs', () => {
    it('binds the URL to the document, user and expiry', () => {
        const url = new URL(signDocumentUrl('s', 'doc1', 'u1', 2000), 'http://x');
        const exp = url.searchParams.get('exp');
        const sig = url.searchParams.get('sig');
        expect(verifyDocumentUrl('s', 'doc1', 'u1', exp, sig, 1000)).toBe(true);
        expect(verifyDocumentUrl('s', 'doc1', 'u2', exp, sig, 1000)).toBe(false);
        expect(verifyDocumentUrl('s', 'doc2', 'u1', exp, sig, 1000)).toBe(false);
        expect(verifyDocumentUrl('s', 'doc1', 'u1', exp, sig, 2001)).toBe(false);
        expect(verifyDocumentUrl('s', 'doc1', 'u1', '9999', sig, 1000)).toBe(false);
    });
});

describe('TOTP (RFC 6238 test vector)', () => {
    // RFC 6238 Appendix B secret "12345678901234567890" in base32; SHA-1, T=59s -> 94287082 (8 digits) -> last 6 = 287082
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    it('matches the RFC vector', () => {
        expect(totp(secret, 59_000)).toBe('287082');
        expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
        expect(verifyTotp(secret, '287083', 59_000)).toBe(false);
        expect(verifyTotp(secret, 'abc', 59_000)).toBe(false);
    });
});

describe('rate limiter', () => {
    it('blocks after the limit within the window and resets after', () => {
        const rl = new InMemoryRateLimiter();
        expect(rl.consume('k', 2, 1000, 0).allowed).toBe(true);
        expect(rl.consume('k', 2, 1000, 1).allowed).toBe(true);
        expect(rl.consume('k', 2, 1000, 2).allowed).toBe(false);
        expect(rl.consume('k', 2, 1000, 1001).allowed).toBe(true);
    });
});

describe('canonical JSON', () => {
    it('is key-order independent', () => {
        expect(canonicalJson({ b: 1, a: { d: 2n, c: [1, 'x'] } })).toBe(canonicalJson({ a: { c: [1, 'x'], d: 2n }, b: 1 }));
    });
});
