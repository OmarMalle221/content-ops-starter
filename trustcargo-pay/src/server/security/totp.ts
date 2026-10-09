/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) used for demo step-up MFA.
 * In production, MFA is delegated to Supabase Auth (AAL2); this module stays for tests/demo only.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
    const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = BASE32.indexOf(ch);
        if (idx < 0) throw new Error('Invalid base32 secret');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', secret).update(buf).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const code = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
    return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secretBase32: string, at: number = Date.now(), step = 30): string {
    return hotp(base32Decode(secretBase32), Math.floor(at / 1000 / step));
}

/** Accepts the current code and ±1 step to tolerate clock drift. */
export function verifyTotp(secretBase32: string, code: string, at: number = Date.now(), step = 30): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    const counter = Math.floor(at / 1000 / step);
    const secret = base32Decode(secretBase32);
    return [-1, 0, 1].some((d) => timingSafeEqual(Buffer.from(hotp(secret, counter + d)), Buffer.from(code)));
}
