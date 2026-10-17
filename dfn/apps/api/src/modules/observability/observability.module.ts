import { Global, Inject, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { DomainGaugesService } from './domain-gauges.service';
import { MetricsEndpointMiddleware } from './metrics-endpoint.middleware';
import { MetricsService } from './metrics.service';
import { RequestInstrumentationMiddleware } from './request-instrumentation.middleware';

/**
 * Phase 7 — observability: Prometheus metrics (GET /metrics), HTTP instrumentation keyed by route
 * template, domain gauges read from the database at scrape time, and W3C trace-context propagation
 * (trace-context.ts; the pino fields are wired in the LoggerModule block of app.module.ts and the
 * outgoing webhook header in api-platform/webhook-http.ts). Global so that any module can record
 * metrics through MetricsService without importing it explicitly. Both middlewares are applied
 * here, in this order: the instrumentation also counts and traces the scrapes themselves.
 */
@Global()
@Module({
  providers: [MetricsService, DomainGaugesService],
  exports: [MetricsService, DomainGaugesService],
})
export class ObservabilityModule implements NestModule {
  constructor(@Inject(ENV) private readonly env: Env) {}

  configure(consumer: MiddlewareConsumer) {
    // `{*path}` (optional wildcard) rather than `*path`: path-to-regexp 8 requires at least one
    // segment for `/*path`, so the bare root path — load-balancer and uptime probes — would bypass
    // the instrumentation and be neither counted nor traced.
    consumer.apply(RequestInstrumentationMiddleware).forRoutes('{*path}');
    if (this.env.METRICS_ENABLED) {
      consumer.apply(MetricsEndpointMiddleware).forRoutes({ path: 'metrics', method: RequestMethod.GET });
    }
  }
}
