import { timingSafeEqual } from 'node:crypto';

/**
 * Who may read GET /metrics. With METRICS_TOKEN set: `Authorization: Bearer <token>` only, compared
 * in constant time (a wrong token is 401, loopback or not). Without a token: the TCP peer must be
 * loopback — `socket.remoteAddress`, never `req.ip` / X-Forwarded-For, which a remote client can
 * choose — and the request must not have been forwarded by a proxy: a proxy on the same host (the
 * web app's same-origin `/api` rewrite in `pnpm dev`, a reverse proxy) is itself a loopback peer
 * and would otherwise lend its locality to any remote client. Forwarding headers are only ever
 * used to refuse (a client cannot gain access by adding one). Pure functions: an HTTP test cannot
 * fake a non-loopback peer, so the predicate is unit-tested directly.
 */
export type MetricsAccessDecision = 'allowed' | 'unauthorized' | 'forbidden';

/**
 * Headers a proxy adds when it forwards a request: RFC 7239 `Forwarded`, the de-facto
 * `X-Forwarded-*` family (Next.js sets `X-Forwarded-Host`, nginx / Caddy / Traefik set
 * `X-Forwarded-For`), nginx's `X-Real-IP` and `Via` (RFC 9110).
 */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
] as const;

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms (dotted `::ffff:127.0.0.1` or hex `::ffff:7f00:1`). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.trim().toLowerCase();
  if (value === '::1') return true;
  const v4 = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!v4.includes('.')) {
    if (!value.startsWith('::ffff:')) return false;
    const groups = v4.split(':');
    if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return false;
    return parseInt(groups[0]!, 16) >> 8 === 127;
  }
  const octets = v4.split('.');
  return (
    octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255) && octets[0] === '127'
  );
}

/** True when the request carries any forwarding header (Node lower-cases header names). */
export function isForwardedRequest(headers: Record<string, unknown>): boolean {
  return FORWARDING_HEADERS.some((name) => {
    const value = headers[name];
    return typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0;
  });
}

export function bearerTokenMatches(authorization: string | undefined, expected: string): boolean {
  if (typeof authorization !== 'string' || expected.length === 0) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) return false;
  const presented = Buffer.from(match[1]!, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  // Different lengths cannot match; a comparison still runs so timing does not reveal the length.
  if (presented.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(presented, wanted);
}

export function metricsAccess(input: {
  token?: string;
  authorization?: string;
  remoteAddress?: string;
  /** The request came through a proxy (isForwardedRequest): never a local agent. */
  forwarded?: boolean;
}): MetricsAccessDecision {
  if (input.token) return bearerTokenMatches(input.authorization, input.token) ? 'allowed' : 'unauthorized';
  return isLoopbackAddress(input.remoteAddress) && !input.forwarded ? 'allowed' : 'forbidden';
}
