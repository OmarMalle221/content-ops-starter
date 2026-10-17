import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { ENV, type Env } from '../../config/env';

/** Every metric of this process, default Node.js / process metrics included, carries this prefix. */
export const METRICS_PREFIX = 'dfn_';

/** Seconds. Reads target < 500 ms p95 (docs/operations/PERFORMANCE.md); the upper buckets catch stalls. */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Prometheus registry of this replica. One registry per process (not prom-client's global one, so
 * tests boot several applications side by side), rendered by GET /metrics. HTTP series are keyed by
 * route template (route-template.ts); the domain gauges live in DomainGaugesService.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>;
  readonly httpRequestDuration: Histogram<'method' | 'route'>;

  constructor(@Inject(ENV) env: Env) {
    collectDefaultMetrics({ register: this.registry, prefix: METRICS_PREFIX });
    new Gauge({
      name: 'dfn_api_info',
      help: 'Static facts about this API replica (always 1). The sandbox handles fictitious funds only.',
      labelNames: ['instance_id', 'mode', 'node_version'],
      registers: [this.registry],
    }).set({ instance_id: env.INSTANCE_ID, mode: 'sandbox', node_version: process.version }, 1);
    this.httpRequestsTotal = new Counter({
      name: 'dfn_http_requests_total',
      help: 'HTTP requests answered, by method, route template and status code.',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpRequestDuration = new Histogram({
      name: 'dfn_http_request_duration_seconds',
      help: 'Time from the first middleware to the end of the response, by method and route template.',
      labelNames: ['method', 'route'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });
  }

  observeHttpRequest(method: string, route: string, statusCode: number, seconds: number) {
    this.httpRequestsTotal.inc({ method, route, status: String(statusCode) });
    this.httpRequestDuration.observe({ method, route }, seconds);
  }

  /** `text/plain; version=0.0.4; charset=utf-8` (Prometheus exposition format). */
  get contentType(): string {
    return this.registry.contentType;
  }

  /** Runs every `collect()` callback (domain gauges) and renders the exposition text. */
  render(): Promise<string> {
    return this.registry.metrics();
  }
}
