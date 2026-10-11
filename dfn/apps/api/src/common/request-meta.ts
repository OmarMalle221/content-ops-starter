import type { Request } from 'express';

export function requestMeta(req: Request): { ip?: string; userAgent?: string } {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() ||
    req.ip ||
    req.socket?.remoteAddress;
  return { ip: ip ?? undefined, userAgent: req.headers['user-agent']?.slice(0, 300) };
}
