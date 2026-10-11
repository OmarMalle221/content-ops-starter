import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { SANDBOX_HEADER, SANDBOX_MODE } from '@dfn/shared';
import { Observable } from 'rxjs';

/** Every API response is tagged so that no client can mistake the sandbox for a live environment. */
@Injectable()
export class SandboxHeaderInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader(SANDBOX_HEADER, SANDBOX_MODE);
    res.setHeader('x-dfn-disclaimer', 'Simulated data - no real funds');
    return next.handle();
  }
}
