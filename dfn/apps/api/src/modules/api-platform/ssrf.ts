import { HttpStatus } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiPlatformErrorCode } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';

/**
 * Outbound webhook URLs must never point at the platform itself or at private networks.
 *
 * Two layers:
 *  1. `assertSafeWebhookUrl` — synchronous, at subscription time: scheme, credentials and a
 *     lexical check of literal IP addresses / local hostnames (`isPrivateWebhookHost`).
 *  2. `unsafeDestinationReason` — asynchronous, at dispatch time: resolves the hostname and
 *     rejects if ANY resolved address is private, so DNS names pointing at internal ranges
 *     (and DNS rebinding between two deliveries) are refused too.
 *
 * Optional egress allowlist (`WEBHOOK_ALLOWED_HOSTS`, comma-separated exact hosts or `*.suffix`):
 * when configured, any host outside the list is refused by both layers — including under
 * `NODE_ENV=test`, so that it is testable. It never relaxes the private-address checks.
 *
 * The `NODE_ENV=test` exception exists only so that the integration tests can run a local receiver.
 */

function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** Parses the allowlist; null when unset or blank (no restriction). */
export function parseAllowedHosts(allowedHosts: string | undefined | null): string[] | null {
  if (!allowedHosts) return null;
  const entries = allowedHosts
    .split(',')
    .map((h) => normalizeHost(h))
    .filter((h) => h.length > 0);
  return entries.length ? entries : null;
}

/**
 * Exact host match, or `*.suffix` matching any sub-domain of `suffix` (one label or more) — but not
 * `suffix` itself. Comparison is case-insensitive and ignores a trailing dot and IPv6 brackets.
 */
export function isHostAllowed(hostname: string, allowedHosts: string | undefined | null): boolean {
  const list = parseAllowedHosts(allowedHosts);
  if (!list) return true;
  const host = normalizeHost(hostname);
  if (!host) return false;
  return list.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.com"
      return suffix.length > 1 && host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entry;
  });
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

/** RFC 1918 + loopback + link-local + CGNAT + unspecified + multicast/reserved/broadcast. */
export function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparsable → refuse
  return (
    inRange(n, '0.0.0.0', 8) ||
    inRange(n, '10.0.0.0', 8) ||
    inRange(n, '100.64.0.0', 10) ||
    inRange(n, '127.0.0.0', 8) ||
    inRange(n, '169.254.0.0', 16) ||
    inRange(n, '172.16.0.0', 12) ||
    inRange(n, '192.0.0.0', 24) ||
    inRange(n, '192.0.2.0', 24) ||
    inRange(n, '192.168.0.0', 16) ||
    inRange(n, '198.18.0.0', 15) ||
    inRange(n, '198.51.100.0', 24) ||
    inRange(n, '203.0.113.0', 24) ||
    inRange(n, '224.0.0.0', 3) // multicast + reserved + broadcast (224.0.0.0 – 255.255.255.255)
  );
}

/** Expands an IPv6 literal into 8 hextets (numbers); returns null when it cannot be parsed. */
function expandIpv6(ip: string): number[] | null {
  let v6 = ip;
  // Embedded dotted IPv4 (e.g. ::ffff:127.0.0.1) → convert the tail to two hextets.
  const lastColon = v6.lastIndexOf(':');
  const tail = v6.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = ipv4ToInt(tail);
    if (n === null) return null;
    v6 = `${v6.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}

/** Loopback, unspecified, link-local, unique-local, IPv4-mapped/compatible/translated and documentation ranges. */
export function isPrivateIpv6(ip: string): boolean {
  const h = expandIpv6(ip);
  if (!h) return true; // unparsable → refuse
  const isZero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (isZero(0, 7) && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96) → check the v4
  const embedded = (idx: number) =>
    `${h[idx]! >>> 8}.${h[idx]! & 0xff}.${h[idx + 1]! >>> 8}.${h[idx + 1]! & 0xff}`;
  if (isZero(0, 5) && (h[5] === 0xffff || h[5] === 0)) return isPrivateIpv4(embedded(6));
  if (h[0] === 0x0064 && h[1] === 0xff9b && isZero(2, 6)) return isPrivateIpv4(embedded(6));
  return false;
}

/** True for any literal IP address or well-known local name that must never receive a webhook. */
export function isPrivateWebhookHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.in-addr.arpa'))
    return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) return isPrivateIpv6(host);
  return false;
}

export function assertSafeWebhookUrl(
  url: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allowedHosts?: string,
) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw DomainError.validation('Webhook URL is invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw DomainError.validation('Webhook URL must use http(s)');
  }
  if (parsed.username || parsed.password) {
    throw new DomainError(
      ApiPlatformErrorCode.WEBHOOK_URL_FORBIDDEN,
      'Webhook URL must not embed credentials',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  // The allowlist applies in every environment (test included); it does not bypass the checks below.
  if (!isHostAllowed(parsed.hostname, allowedHosts)) {
    throw new DomainError(
      ApiPlatformErrorCode.WEBHOOK_URL_FORBIDDEN,
      'Webhook host is not in the allowed destinations of this platform (WEBHOOK_ALLOWED_HOSTS)',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { hostname: parsed.hostname },
    );
  }
  if (nodeEnv === 'test') return parsed;
  if (isPrivateWebhookHost(parsed.hostname)) {
    throw new DomainError(
      ApiPlatformErrorCode.WEBHOOK_URL_FORBIDDEN,
      'Webhook URL must point to a public host (localhost and private networks are rejected)',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { hostname: parsed.hostname },
    );
  }
  return parsed;
}

/**
 * Dispatch-time check: resolves the hostname and refuses the delivery when any address is private.
 * Returns the reason string (for the delivery row) or null when the destination is acceptable.
 */
export async function unsafeDestinationReason(
  url: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allowedHosts?: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (!isHostAllowed(parsed.hostname, allowedHosts))
    return `host ${parsed.hostname} is not in the webhook allowlist`;
  if (nodeEnv === 'test') return null;
  const host = parsed.hostname;
  if (isPrivateWebhookHost(host)) return `private host ${host}`;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return null;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return `host ${host} does not resolve`;
    for (const a of addresses) {
      const priv = a.family === 6 ? isPrivateIpv6(a.address) : isPrivateIpv4(a.address);
      if (priv) return `host ${host} resolves to a private address`;
    }
    return null;
  } catch (err) {
    return `host ${host} could not be resolved (${err instanceof Error ? err.message : String(err)})`;
  }
}
