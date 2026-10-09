import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@/domain/canonical';

export function sha256Hex(data: string | Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

export function hashCanonical(value: unknown): string {
    return sha256Hex(canonicalJson(value));
}

export function hmacHex(secret: string, data: string): string {
    return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** URL-safe random token with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

/** Pseudonymises an IP/device identifier for logs (keyed so it cannot be reversed by dictionary). */
export function pseudonymize(secret: string, value: string): string {
    return hmacHex(secret, `pseudo:${value}`).slice(0, 32);
}
