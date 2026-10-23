import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { SCAN_FAILURE_REASONS } from '../../common/antivirus/scanner';
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
  /** Antivirus verdicts of uploads (UNAVAILABLE = refused 503, fail closed, with its reason). */
  readonly documentScans: Counter<'engine' | 'outcome' | 'reason'>;

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
    this.documentScans = new Counter({
      name: 'dfn_document_scans_total',
      help: 'Antivirus scans of uploads by engine, outcome (CLEAN, INFECTED, UNAVAILABLE: refused, fail closed; SKIPPED: scanning disabled) and reason (why no verdict; "none" otherwise). The sandbox-eicar engine is a simulation.',
      labelNames: ['engine', 'outcome', 'reason'],
      registers: [this.registry],
    });
  }

  /** Counts one antivirus outcome; `engine` is null when scanning is disabled. */
  recordDocumentScan(
    engine: string | null,
    outcome: 'CLEAN' | 'INFECTED' | 'UNAVAILABLE' | 'SKIPPED',
    reason: (typeof SCAN_FAILURE_REASONS)[number] | 'none' = 'none',
  ) {
    this.documentScans.inc({ engine: engine ?? 'none', outcome, reason });
  }

  /** Exposes the series of `engine` at 0, so that rate()/increase() see the first failure. */
  initDocumentScans(engine: string | null) {
    const name = engine ?? 'none';
    if (!engine) {
      this.documentScans.inc({ engine: name, outcome: 'SKIPPED', reason: 'none' }, 0);
      return;
    }
    for (const outcome of ['CLEAN', 'INFECTED'] as const)
      this.documentScans.inc({ engine: name, outcome, reason: 'none' }, 0);
    for (const reason of SCAN_FAILURE_REASONS)
      this.documentScans.inc({ engine: name, outcome: 'UNAVAILABLE', reason }, 0);
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
