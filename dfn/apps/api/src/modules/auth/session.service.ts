import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthContext } from '../../common/auth-context';
import { hmacHex, randomToken } from '../../common/crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private hash(token: string) {
    return hmacHex(this.env.SESSION_SECRET, token);
  }

  async create(userId: string, req: Request, options: { mfaVerified: boolean }) {
    const token = randomToken(32);
    const meta = requestMeta(req);
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        mfaVerified: options.mfaVerified,
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + this.env.SESSION_TTL_HOURS * 3600 * 1000),
      },
    });
    return { token, session };
  }

  setCookie(res: Response, token: string) {
    res.cookie(this.env.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.COOKIE_SECURE,
      path: '/',
      maxAge: this.env.SESSION_TTL_HOURS * 3600 * 1000,
    });
  }

  clearCookie(res: Response) {
    res.clearCookie(this.env.SESSION_COOKIE_NAME, { path: '/' });
  }

  tokenFromRequest(req: Request): string | undefined {
    const cookies = (req as any).cookies as Record<string, string> | undefined;
    const fromCookie = cookies?.[this.env.SESSION_COOKIE_NAME];
    if (fromCookie) return fromCookie;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return undefined;
  }

  async resolveFromRequest(req: Request): Promise<AuthContext | null> {
    const token = this.tokenFromRequest(req);
    if (!token) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        user: {
          include: {
            memberships: { include: { organization: { select: { id: true, name: true, type: true } } } },
          },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
    if (session.user.status !== 'ACTIVE' || session.user.deletedAt) return null;
    // Sliding activity timestamp (throttled to once per minute to avoid write amplification)
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
    const meta = requestMeta(req);
    return {
      userId: session.user.id,
      sessionId: session.id,
      email: session.user.email,
      firstName: session.user.firstName,
      lastName: session.user.lastName,
      locale: session.user.locale,
      globalRole: session.user.globalRole,
      mfaEnabled: session.user.mfaEnabled,
      mfaVerified: session.mfaVerified,
      memberships: session.user.memberships.map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organization.name,
        organizationType: m.organization.type,
        role: m.role,
      })),
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
  }

  async markMfaVerified(sessionId: string) {
    await this.prisma.session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
  }

  async revoke(sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  async listForUser(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        mfaVerified: true,
      },
    });
  }
}
