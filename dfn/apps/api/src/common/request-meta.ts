import type { Request } from 'express';

/**
 * Client address and user agent for audit entries and sessions. The address is Express's
 * `req.ip`: X-Forwarded-For is honoured only through the peers listed in TRUST_PROXY (the same
 * address the rate limits use), never read raw — a client cannot pick the address it is audited
 * under.
 */
export function requestMeta(req: Request): { ip?: string; userAgent?: string } {
  const ip = req.ip || req.socket?.remoteAddress;
  return { ip: ip ?? undefined, userAgent: req.headers['user-agent']?.slice(0, 300) };
}
