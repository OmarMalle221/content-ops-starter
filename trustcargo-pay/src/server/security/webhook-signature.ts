/**
 * Partner webhook authentication: HMAC-SHA256 over `${timestamp}.${rawBody}`.
 * Header format: `t=<unix seconds>,v1=<hex signature>`. Timestamps outside the tolerance window are
 * rejected (replay protection, complemented by unique (provider, external_event_id) storage).
 */
import { hmacHex, safeEqualHex } from './crypto';

export const SIGNATURE_HEADER = 'x-trustcargo-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure = 'MISSING' | 'MALFORMED' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'MISMATCH';

export function signPayload(secret: string, rawBody: string, timestampSeconds: number): string {
    return `t=${timestampSeconds},v1=${hmacHex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export function verifySignature(
    secret: string,
    rawBody: string,
    header: string | null | undefined,
    nowSeconds: number = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): { ok: true; timestamp: number } | { ok: false; reason: SignatureFailure } {
    if (!header) return { ok: false, reason: 'MISSING' };
    const parts = Object.fromEntries(
        header.split(',').map((p) => {
            const [k, ...v] = p.trim().split('=');
            return [k, v.join('=')];
        })
    );
    const timestamp = Number(parts.t);
    const signature = parts.v1;
    if (!Number.isInteger(timestamp) || !signature) return { ok: false, reason: 'MALFORMED' };
    if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
    const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
    return safeEqualHex(expected, signature) ? { ok: true, timestamp } : { ok: false, reason: 'MISMATCH' };
}
