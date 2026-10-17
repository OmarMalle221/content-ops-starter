import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { methodLabel, routeTemplate } from './route-template';
import { runWithTraceContext, traceContextFor } from './trace-context';

/**
 * First observability hook of every request: fixes the trace context (continued from a valid
 * incoming `traceparent` or new), returns it as the `traceparent` response header, runs the rest of
 * the chain inside it (AsyncLocalStorage, so outgoing webhooks become child spans) and, when the
 * response is finished, records dfn_http_requests_total / dfn_http_request_duration_seconds keyed
 * by the route template the router matched — guard rejections and 404s included. Requests the
 * CSRF origin check rejects before this middleware runs (AppModule middleware is applied first) are
 * the only answers not counted.
 */
@Injectable()
export class RequestInstrumentationMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const ctx = traceContextFor(req, res);
    const startedAt = process.hrtime.bigint();
    // Nest mounts this middleware as a route of its own: unless a controller route replaces it,
    // `req.route` still points at it when the response finishes (route-template.ts).
    const ownRoute: unknown = req.route;
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.observeHttpRequest(
        methodLabel(req.method),
        routeTemplate(req, res.locals.routeTemplate, ownRoute),
        res.statusCode,
        seconds,
      );
    });
    runWithTraceContext(ctx, next);
  }
}
