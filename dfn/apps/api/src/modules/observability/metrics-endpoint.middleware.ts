import { HttpStatus, Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode, type ApiErrorBody } from '@dfn/shared';
import { ENV, type Env } from '../../config/env';
import { isForwardedRequest, metricsAccess } from './metrics-access';
import { MetricsService } from './metrics.service';
import { METRICS_ROUTE } from './route-template';

/**
 * GET /metrics, answered by a middleware rather than a controller so that it is never behind the
 * global guards: SessionAuthGuard looks every `Bearer` token up as a session (a scrape would then
 * depend on the database and fail with it), ThrottlerGuard on the rate-limit store. Access is
 * decided by metrics-access.ts (bearer METRICS_TOKEN, else a loopback peer that no proxy forwarded).
 * Not registered at all when METRICS_ENABLED=false: the path then falls through to Nest's 404.
 */
@Injectable()
export class MetricsEndpointMiddleware implements NestMiddleware {
  private readonly logger = new Logger(MetricsEndpointMiddleware.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: MetricsService,
  ) {}

  async use(req: Request, res: Response) {
    res.locals.routeTemplate = METRICS_ROUTE;
    res.setHeader('Cache-Control', 'no-store');
    const decision = metricsAccess({
      token: this.env.METRICS_TOKEN,
      authorization: req.headers.authorization,
      remoteAddress: req.socket?.remoteAddress,
      forwarded: isForwardedRequest(req.headers),
    });
    if (decision !== 'allowed') {
      const unauthorized = decision === 'unauthorized';
      if (unauthorized) res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      const body: ApiErrorBody = unauthorized
        ? {
            statusCode: HttpStatus.UNAUTHORIZED,
            code: ErrorCode.UNAUTHENTICATED,
            message: 'A valid metrics bearer token is required',
          }
        : {
            statusCode: HttpStatus.FORBIDDEN,
            code: ErrorCode.FORBIDDEN,
            message:
              'Metrics are served to direct loopback peers only (no proxy) unless METRICS_TOKEN is configured',
          };
      res.status(body.statusCode).json(body);
      return;
    }
    try {
      const text = await this.metrics.render();
      res.status(HttpStatus.OK).setHeader('Content-Type', this.metrics.contentType);
      res.send(text);
    } catch (err) {
      this.logger.error(`metrics rendering failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).type('text/plain').send('metrics unavailable');
    }
  }
}
