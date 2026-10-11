import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import type { AuthContext } from '../../common/auth-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';

const ATTACHED = Symbol('dfnApiRequestLogAttached');
type LoggedRequest = Request & { auth?: AuthContext; id?: string; [ATTACHED]?: boolean };

/**
 * Persists one ApiRequestLog row per API-key request. The row is written when the response
 * finishes (so the final status code is known, including the one set by the exception filter),
 * fire-and-forget: a logging failure never affects the partner's response.
 *
 * The guard attaches the hook as soon as the key is authenticated so that 403/429 refusals are
 * journaled too; the interceptor attaches it for any path the guard did not cover.
 */
@Injectable()
export class ApiRequestLogService {
  private readonly logger = new Logger(ApiRequestLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  attach(req: Request, res: Response, credentialId: string) {
    const r = req as LoggedRequest;
    if (r[ATTACHED]) return;
    r[ATTACHED] = true;
    const startedAt = Date.now();
    const method = req.method;
    const path = (req.originalUrl ?? req.url).split('?')[0]?.slice(0, 300) ?? '';
    const { ip } = requestMeta(req);
    const requestId = (r.id ?? req.headers['x-request-id'])?.toString().slice(0, 100);
    res.once('finish', () => {
      void this.prisma.apiRequestLog
        .create({
          data: {
            credentialId,
            method,
            path,
            statusCode: res.statusCode,
            durationMs: Math.max(Date.now() - startedAt, 0),
            ip: ip ?? null,
            requestId: requestId ?? null,
          },
        })
        .catch((err: unknown) =>
          this.logger.debug(`request log skipped: ${err instanceof Error ? err.message : String(err)}`),
        );
    });
  }
}

@Injectable()
export class ApiRequestLogInterceptor implements NestInterceptor {
  constructor(private readonly logs: ApiRequestLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<LoggedRequest>();
    const credentialId = req.auth?.apiCredential?.id;
    if (credentialId) this.logs.attach(req, http.getResponse<Response>(), credentialId);
    return next.handle();
  }
}
