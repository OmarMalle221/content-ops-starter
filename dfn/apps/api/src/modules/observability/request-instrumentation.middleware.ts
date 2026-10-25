import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { methodLabel, routeTemplate } from './route-template';
import { nowUnixNano, recordSpan, spanExportEnabled } from './span-recorder';
import { runWithTraceContext, traceContextFor } from './trace-context';

/**
 * First observability hook of every request: fixes the trace context (continued from a valid
 * incoming `traceparent` or new), returns it as the `traceparent` response header, runs the rest of
 * the chain inside it (AsyncLocalStorage, so outgoing webhooks become child spans) and, when the
 * response is finished, records dfn_http_requests_total / dfn_http_request_duration_seconds keyed
 * by the route template the router matched — guard rejections and 404s included — and, when span
 * export is on, the request's server span (same ids as its logs and `traceparent`). Requests the
 * CSRF origin check rejects before this middleware runs (AppModule middleware is applied first) are
 * the only answers not counted.
 */
@Injectable()
export class RequestInstrumentationMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const ctx = traceContextFor(req, res);
    const startedAt = process.hrtime.bigint();
    const startedAtUnixNano = spanExportEnabled() ? nowUnixNano() : 0n;
    // Nest mounts this middleware as a route of its own: unless a controller route replaces it,
    // `req.route` still points at it when the response finishes (route-template.ts).
    const ownRoute: unknown = req.route;
    res.once('finish', () => {
      const elapsed = process.hrtime.bigint() - startedAt;
      const method = methodLabel(req.method);
      const route = routeTemplate(req, res.locals.routeTemplate, ownRoute);
      this.metrics.observeHttpRequest(method, route, res.statusCode, Number(elapsed) / 1e9);
      if (startedAtUnixNano === 0n) return;
      // Route template, never the raw URL: no ids, query string or token in the span.
      const requestId = (req as { id?: unknown }).id;
      recordSpan(
        {
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: ctx.parentSpanId,
          name: `${method} ${route}`,
          kind: 'SERVER',
          startTimeUnixNano: startedAtUnixNano,
          endTimeUnixNano: startedAtUnixNano + elapsed,
          attributes: {
            'http.request.method': method,
            'http.route': route,
            'http.response.status_code': res.statusCode,
            ...(typeof requestId === 'string' ? { 'dfn.request_id': requestId.slice(0, 64) } : {}),
          },
          error: res.statusCode >= 500 ? `HTTP ${res.statusCode}` : undefined,
        },
        ctx.flags,
      );
    });
    runWithTraceContext(ctx, next);
  }
}
