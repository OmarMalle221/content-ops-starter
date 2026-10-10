import { isIPv6 } from 'node:net';

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
 * An IPv6 address is reduced to its /64 prefix (ipBucket): one host or subscriber usually holds a whole /64, so the
 * full address would hand it a fresh rate-limit bucket per request.
 *
 * Next.js only fills X-Forwarded-For when the request has none: an app exposed without a reverse proxy in front
 * therefore sees a client-controlled header. Deploy behind the platform's proxy, or set CLIENT_IP_HEADER
 * (docs/DEPLOYMENT.md).
 */
const MAX_IP_LENGTH = 64;

export function clientIp(headers: { get(name: string): string | null }, clientIpHeader?: string): string {
    const raw = clientIpHeader ? headers.get(clientIpHeader) : headers.get('x-forwarded-for')?.split(',').at(-1);
    const ip = raw?.trim().slice(0, MAX_IP_LENGTH);
    return ip ? ipBucket(ip) : 'unknown';
}

/** Hex groups of an IPv6 address without zone (an embedded IPv4 tail becomes two groups). */
function ipv6Groups(address: string): number[] {
    const part = (text: string) => {
        if (!text) return [];
        const groups = text.split(':');
        const last = groups.at(-1)!;
        if (!last.includes('.')) return groups.map((g) => parseInt(g, 16));
        const [a, b, c, d] = last.split('.').map(Number) as [number, number, number, number];
        return [...groups.slice(0, -1).map((g) => parseInt(g, 16)), (a << 8) | b, (c << 8) | d];
    };
    const [head, tail] = address.split('::') as [string, string | undefined];
    if (tail === undefined) return part(head);
    const before = part(head);
    const after = part(tail);
    return [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
}

/**
 * Rate-limit key of a client address: IPv4 (and IPv4-mapped IPv6) unchanged, any other IPv6 address its /64 prefix
 * (`2001:db8:1:2::/64`). Anything else is returned as is (idempotent: a bucket maps to itself).
 */
export function ipBucket(ip: string): string {
    const address = ip.replace(/^\[(.*)\](?::\d+)?$/, '$1').replace(/%.*$/, '');
    if (!isIPv6(address)) return ip;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return mapped[1]!;
    return `${ipv6Groups(address)
        .slice(0, 4)
        .map((g) => g.toString(16))
        .join(':')}::/64`;
}
