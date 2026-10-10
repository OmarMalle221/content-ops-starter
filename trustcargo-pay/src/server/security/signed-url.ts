/**
 * Short-lived signed document URLs bound to a user. The download route re-checks authorisation
 * as well (defence in depth); the signature only prevents link sharing / guessing.
 */
import { hmacHex, safeEqualHex } from './crypto';

export function signDocumentUrl(secret: string, documentId: string, userId: string, expiresAtSeconds: number): string {
    const sig = hmacHex(secret, `doc:${documentId}:${userId}:${expiresAtSeconds}`);
    return `/api/v1/documents/${documentId}/content?exp=${expiresAtSeconds}&sig=${sig}`;
}

export function verifyDocumentUrl(
    secret: string,
    documentId: string,
    userId: string,
    exp: string | null,
    sig: string | null,
    nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    if (Number(exp) < nowSeconds) return false;
    return safeEqualHex(hmacHex(secret, `doc:${documentId}:${userId}:${exp}`), sig);
}
