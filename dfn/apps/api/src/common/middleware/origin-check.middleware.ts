import { HttpStatus, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ENV, type Env } from '../../config/env';
import { DomainError } from '../domain-error';

/**
 * CSRF defence in depth: cookies are SameSite=Lax, and in addition every state-changing
 * request that carries an Origin header must come from an allowed web origin.
 */
@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  private readonly allowed: Set<string>;
  constructor(@Inject(ENV) env: Env) {
    this.allowed = new Set(
      env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
        .concat(env.API_PUBLIC_URL),
    );
  }
  use(req: Request, _res: Response, next: NextFunction) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !this.allowed.has(origin)) {
      throw new DomainError('CSRF_ORIGIN_REJECTED', 'Origin not allowed', HttpStatus.FORBIDDEN);
    }
    next();
  }
}
