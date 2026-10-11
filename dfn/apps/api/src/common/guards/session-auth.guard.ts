import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../domain-error';
import { ALLOW_PRE_MFA_KEY, IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SessionService } from '../../modules/auth/session.service';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & { auth?: unknown }>();
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
}
