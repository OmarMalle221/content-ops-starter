/**
 * Client IP used for rate limiting and for the pseudonymised session events. One rule for every entry point
 * (server actions and the auth callback through clientFingerprint, the REST API, the partner webhook):
 *
 * - CLIENT_IP_HEADER set (fly-client-ip, cf-connecting-ip, x-nf-client-connection-ip, x-real-ip…): the value the
 *   platform's edge writes, replacing whatever the client sent. When it is missing the request did not come through
 *   that edge: 'unknown' (one shared bucket), never a value the client chose.
 * - Otherwise the RIGHT-most X-Forwarded-For entry: the address appended by the nearest proxy. Entries to its left
 *   were sent by the client and are ignored.
 *
 * Next.js only fills X-Forwarded-For when the request has none: an app exposed without a reverse proxy in front
 * therefore sees a client-controlled header. Deploy behind the platform's proxy (docs/DEPLOYMENT.md).
 */
const MAX_IP_LENGTH = 64;

export function clientIp(headers: { get(name: string): string | null }, clientIpHeader?: string): string {
    const raw = clientIpHeader ? headers.get(clientIpHeader) : headers.get('x-forwarded-for')?.split(',').at(-1);
    const ip = raw?.trim().slice(0, MAX_IP_LENGTH);
    return ip || 'unknown';
}
