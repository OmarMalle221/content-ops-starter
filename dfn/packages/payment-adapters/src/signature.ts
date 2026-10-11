import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 signature used for simulated partner webhooks and (later) outbound webhooks. */
export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
