import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../domain-error';
import { ALLOW_PRE_MFA_KEY, IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SessionService } from '../../modules/auth/session.service';
import { ApiAuthService } from '../../modules/api-platform/api-auth.service';
import { ApiRequestLogService } from '../../modules/api-platform/api-request-log.service';
import type { AuthContext } from '../auth-context';

/**
 * Authenticates every request, either with the session (cookie or `Bearer <session token>`)
 * or, when the bearer token is a sandbox secret key (`Bearer dfn_sk_…`), with the Diaspora API
 * credential: per-key rate limit (429 + Retry-After), then route scope (403 SCOPE_FORBIDDEN).
 * The cookie / session path is unchanged.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly apiAuth: ApiAuthService,
    private readonly apiRequestLogs: ApiRequestLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { auth?: unknown }>();

    const apiKey = this.apiAuth.apiKeyFromRequest(req);
    if (apiKey) return this.activateWithApiKey(apiKey, req, http.getResponse<Response>(), isPublic);

    const auth = await this.sessions.resolveFromRequest(req);
    if (auth) req.auth = auth;
    if (isPublic) return true;
    if (!auth)
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Authentication required', HttpStatus.UNAUTHORIZED);
    const allowPreMfa = this.reflector.getAllAndOverride<boolean>(ALLOW_PRE_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (auth.mfaEnabled && !auth.mfaVerified && !allowPreMfa) {
      throw new DomainError(
        ErrorCode.MFA_REQUIRED,
        'Multi-factor authentication required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return true;
  }

  private async activateWithApiKey(
    apiKey: string,
    req: Request & { auth?: unknown },
    res: Response,
    isPublic: boolean,
  ): Promise<boolean> {
    // Invalid, revoked or expired keys are refused even on public routes: a partner that sends
    // a key expects it to be checked. Every request of an identified key is journaled, refusals
    // included (401 revoked / expired, 403 scope, 429 quota) — fire-and-forget on response finish.
    const auth: AuthContext = await this.apiAuth.authenticate(apiKey, req, (credentialId) =>
      this.apiRequestLogs.attach(req, res, credentialId),
    );
    req.auth = auth;
    const credential = auth.apiCredential!;

    const decision = await this.apiAuth.checkRateLimit(credential.id);
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw this.apiAuth.rateLimitedError(decision);
    }
    if (isPublic) return true;
    this.apiAuth.assertScope(auth, req.method, req.originalUrl ?? req.url);
    return true;
  }
}
