import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { API_KEY_PREFIX, ApiPlatformErrorCode, ErrorCode, Permission, orgRoleHas } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { sha256Hex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { requiredScopeFor } from './api-scopes';
import { SlidingWindowRateLimiter, type RateLimitDecision } from './rate-limiter';

/** Minimum delay between two `lastUsedAt` writes for the same credential. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * Authenticates partner API keys (`Authorization: Bearer dfn_sk_…`) and enforces per-key scopes
 * and rate limits. Exported globally so that SessionAuthGuard (APP_GUARD) can inject it.
 */
@Injectable()
export class ApiAuthService {
  private readonly limiter = new SlidingWindowRateLimiter(60_000);
  private readonly lastUsedWrites = new Map<string, number>();
  /** rateLimitPerMinute of the keys seen by this replica (filled at authentication). */
  private readonly limits = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** The bearer token when, and only when, it looks like a sandbox secret key. */
  apiKeyFromRequest(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    const token = header.slice(7).trim();
    return token.startsWith(API_KEY_PREFIX) ? token : undefined;
  }

  /**
   * Resolves the AuthContext of an API key. Throws 401 for unknown, revoked or expired keys, and
   * for keys whose creator is no longer an active member of the organisation with API_MANAGE.
   * The context impersonates the key's creator inside the key's organisation only (role MEMBER):
   * tenant isolation is guaranteed by the single membership, not by the creator's real memberships.
   *
   * `onCredential` is invoked as soon as the key is identified, before the status checks, so that
   * the caller can journal refusals of revoked / expired keys under the right credential.
   */
  async authenticate(
    apiKey: string,
    req: Request,
    onCredential?: (credentialId: string) => void,
  ): Promise<AuthContext> {
    const credential = await this.prisma.apiCredential.findUnique({
      where: { keyHash: sha256Hex(apiKey) },
      include: {
        organization: { select: { id: true, name: true, type: true, deletedAt: true } },
        createdBy: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            locale: true,
            status: true,
            deletedAt: true,
            memberships: { select: { organizationId: true, role: true } },
          },
        },
      },
    });
    if (!credential || credential.organization.deletedAt) {
      throw new DomainError(ApiPlatformErrorCode.API_KEY_INVALID, 'Invalid API key', HttpStatus.UNAUTHORIZED);
    }
    onCredential?.(credential.id);
    if (credential.revokedAt) {
      throw new DomainError(
        ApiPlatformErrorCode.API_KEY_REVOKED,
        'This API key has been revoked',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (credential.expiresAt && credential.expiresAt <= new Date()) {
      throw new DomainError(
        ApiPlatformErrorCode.API_KEY_EXPIRED,
        'This API key has expired',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const creator = credential.createdBy;
    if (!creator || creator.status !== 'ACTIVE' || creator.deletedAt) {
      // A key must always act on behalf of an identifiable, active user (audit trail).
      throw new DomainError(
        ApiPlatformErrorCode.API_KEY_INVALID,
        'This API key is no longer bound to an active user',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // A key does not outlive the membership (or the demotion) of the person who issued it: the
    // creator must still belong to the organisation with a role that may manage API access.
    const membership = creator.memberships.find((m) => m.organizationId === credential.organization.id);
    if (!membership || !orgRoleHas(membership.role, Permission.API_MANAGE)) {
      throw new DomainError(
        ApiPlatformErrorCode.API_KEY_REVOKED,
        'This API key is no longer bound to a member allowed to manage API access for its organisation',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.limits.set(credential.id, credential.rateLimitPerMinute);
    this.touchLastUsed(credential.id);
    const meta = requestMeta(req);
    return {
      userId: creator.id,
      sessionId: `api:${credential.id}`,
      email: creator.email,
      firstName: creator.firstName,
      lastName: creator.lastName,
      locale: creator.locale,
      globalRole: 'USER',
      mfaEnabled: false,
      mfaVerified: true,
      memberships: [
        {
          organizationId: credential.organization.id,
          organizationName: credential.organization.name,
          organizationType: credential.organization.type,
          role: 'MEMBER',
        },
      ],
      ip: meta.ip,
      userAgent: meta.userAgent,
      apiCredential: {
        id: credential.id,
        scopes: credential.scopes,
        organizationId: credential.organization.id,
      },
    };
  }

  /** Sliding-window check; the caller turns a refusal into 429 + Retry-After. */
  async checkRateLimit(credentialId: string): Promise<RateLimitDecision> {
    let limit = this.limits.get(credentialId);
    if (limit === undefined) {
      const credential = await this.prisma.apiCredential.findUnique({
        where: { id: credentialId },
        select: { rateLimitPerMinute: true },
      });
      limit = credential?.rateLimitPerMinute ?? 120;
      this.limits.set(credentialId, limit);
    }
    return this.limiter.hit(credentialId, limit);
  }

  /** Throws 403 SCOPE_FORBIDDEN when the key does not carry the scope the route requires. */
  assertScope(auth: AuthContext, method: string, path: string) {
    const credential = auth.apiCredential;
    if (!credential) return;
    const required = requiredScopeFor(method, path);
    if (required === null) return;
    if (required === 'FORBIDDEN' || !credential.scopes.includes(required)) {
      throw new DomainError(
        ApiPlatformErrorCode.SCOPE_FORBIDDEN,
        required === 'FORBIDDEN'
          ? 'This endpoint is not available to API keys'
          : `This API key lacks the "${required}" scope`,
        HttpStatus.FORBIDDEN,
        { requiredScope: required === 'FORBIDDEN' ? null : required, scopes: credential.scopes },
      );
    }
  }

  rateLimitedError(decision: RateLimitDecision) {
    return new DomainError(
      ErrorCode.RATE_LIMITED,
      'API key rate limit exceeded',
      HttpStatus.TOO_MANY_REQUESTS,
      {
        limitPerMinute: decision.limit,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    );
  }

  /** Forget in-memory counters of a revoked credential. */
  forget(credentialId: string) {
    this.limiter.reset(credentialId);
    this.lastUsedWrites.delete(credentialId);
    this.limits.delete(credentialId);
  }

  /** `lastUsedAt` is written at most once per minute per key (fire-and-forget). */
  private touchLastUsed(credentialId: string) {
    const now = Date.now();
    const last = this.lastUsedWrites.get(credentialId) ?? 0;
    if (now - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastUsedWrites.set(credentialId, now);
    void this.prisma.apiCredential
      .update({ where: { id: credentialId }, data: { lastUsedAt: new Date(now) } })
      .catch(() => undefined);
  }
}
