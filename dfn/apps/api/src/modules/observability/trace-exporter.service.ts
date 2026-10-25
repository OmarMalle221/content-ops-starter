import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Counter } from 'prom-client';
import { ENV, parseOtlpHeaders, type Env } from '../../config/env';
import { MetricsService } from './metrics.service';
import {
  setSpanSink,
  spanSink,
  type SpanAttributeValue,
  type SpanKind,
  type SpanRecord,
  type SpanSink,
} from './span-recorder';

/** Spans waiting for export; beyond this, new spans are dropped (counted), never buffered. */
export const SPAN_QUEUE_LIMIT = 2048;
/** Spans per export request. */
export const SPAN_BATCH_SIZE = 256;
/** A partial batch leaves at least this often. */
export const SPAN_FLUSH_INTERVAL_MS = 5000;
/** Concurrent export requests; the queue absorbs a slow collector up to SPAN_QUEUE_LIMIT. */
const MAX_INFLIGHT = 2;
/** At most one warning per minute about failed exports (the counter has the full picture). */
const WARN_INTERVAL_MS = 60_000;

const KIND_CODE: Record<SpanKind, number> = { INTERNAL: 1, SERVER: 2, CLIENT: 3 };

function attribute(key: string, value: SpanAttributeValue) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/** OTLP/JSON body (opentelemetry-proto ExportTraceServiceRequest) for one batch. */
export function encodeOtlpTraces(
  spans: SpanRecord[],
  resource: Record<string, SpanAttributeValue>,
  scopeName: string,
) {
  return {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => attribute(k, v)) },
        scopeSpans: [
          {
            scope: { name: scopeName },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND_CODE[s.kind],
              startTimeUnixNano: String(s.startTimeUnixNano),
              endTimeUnixNano: String(s.endTimeUnixNano),
              attributes: Object.entries(s.attributes).map(([k, v]) => attribute(k, v)),
              status: s.error ? { code: 2, message: s.error } : { code: 0 },
            })),
          },
        ],
      },
    ],
  };
}

/**
 * Exports the spans of span-recorder.ts over OTLP/HTTP (JSON encoding) to OTEL_EXPORTER_OTLP_*,
 * in batches, without ever delaying a request: the queue is bounded, a slow or absent collector
 * costs dropped spans (dfn_trace_spans_dropped_total), not memory or latency. Failed batches are
 * not retried (the logs keep trace_id / span_id). Off — no sink installed — without an endpoint.
 */
@Injectable()
export class TraceExporterService implements SpanSink, OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('TraceExporter');
  private readonly url?: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly resource: Record<string, SpanAttributeValue>;
  private readonly scopeName: string;
  private readonly exported: Counter;
  private readonly dropped: Counter<'reason'>;
  private queue: SpanRecord[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private lastWarnAt = 0;

  constructor(@Inject(ENV) env: Env, metrics: MetricsService) {
    const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    this.url =
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (base ? `${base.replace(/\/+$/, '')}/v1/traces` : undefined);
    this.headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS ?? '') ?? {};
    this.timeoutMs = env.OTEL_EXPORTER_OTLP_TIMEOUT;
    this.scopeName = env.OTEL_SERVICE_NAME;
    this.resource = {
      'service.name': env.OTEL_SERVICE_NAME,
      'service.instance.id': env.INSTANCE_ID,
      'deployment.environment.name': 'sandbox',
      'dfn.mode': 'sandbox',
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.versions.node,
    };
    this.exported = new Counter({
      name: 'dfn_trace_spans_exported_total',
      help: 'Spans accepted by the OTLP trace endpoint (OTEL_EXPORTER_OTLP_*).',
      registers: [metrics.registry],
    });
    this.dropped = new Counter({
      name: 'dfn_trace_spans_dropped_total',
      help: 'Spans not exported, by reason: queue_full (collector too slow or absent), export_failed (request failed, timed out or answered non-2xx), rejected (partial success reported by the collector).',
      labelNames: ['reason'],
      registers: [metrics.registry],
    });
    if (this.url)
      for (const reason of ['queue_full', 'export_failed', 'rejected'] as const)
        this.dropped.inc({ reason }, 0);
  }

  get enabled(): boolean {
    return this.url !== undefined;
  }

  onModuleInit() {
    if (!this.url) return;
    setSpanSink(this);
    this.timer = setInterval(() => void this.flush(), SPAN_FLUSH_INTERVAL_MS);
    this.timer.unref();
    // The origin only: a path or query could carry a credential.
    this.logger.log(`Exporting spans (OTLP/HTTP JSON) to ${new URL(this.url).origin}`);
  }

  record(span: SpanRecord) {
    if (this.queue.length >= SPAN_QUEUE_LIMIT) {
      this.dropped.inc({ reason: 'queue_full' });
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= SPAN_BATCH_SIZE) void this.flush();
  }

  /** Sends queued spans, one batch per free slot; resolves when the batches it started are done. */
  flush(): Promise<void> {
    const started: Promise<void>[] = [];
    while (this.url && this.queue.length > 0 && this.inflight.size < MAX_INFLIGHT) {
      const batch = this.queue.splice(0, SPAN_BATCH_SIZE);
      const sending = this.send(this.url, batch).finally(() => {
        this.inflight.delete(sending);
        if (this.queue.length >= SPAN_BATCH_SIZE) void this.flush();
      });
      this.inflight.add(sending);
      started.push(sending);
    }
    return Promise.all(started).then(() => undefined);
  }

  private async send(url: string, batch: SpanRecord[]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify(encodeOtlpTraces(batch, this.resource, this.scopeName)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        this.fail(batch.length, `HTTP ${res.status}`);
        return;
      }
      let rejected = 0;
      try {
        const body = text
          ? (JSON.parse(text) as { partialSuccess?: { rejectedSpans?: number | string } })
          : {};
        rejected = Math.min(batch.length, Number(body.partialSuccess?.rejectedSpans ?? 0) || 0);
      } catch {
        // A 2xx without a JSON body is a full success (OTLP/HTTP specification).
      }
      if (rejected > 0) this.dropped.inc({ reason: 'rejected' }, rejected);
      this.exported.inc(batch.length - rejected);
    } catch (err) {
      this.fail(batch.length, err instanceof Error ? err.name : 'Error');
    }
  }

  private fail(count: number, why: string) {
    this.dropped.inc({ reason: 'export_failed' }, count);
    const now = Date.now();
    if (now - this.lastWarnAt >= WARN_INTERVAL_MS) {
      this.lastWarnAt = now;
      this.logger.warn(`Span export failed (${why}); ${count} spans dropped (dfn_trace_spans_dropped_total)`);
    }
  }

  /** Last flush on shutdown, bounded by the export timeout. */
  async onApplicationShutdown() {
    if (!this.url) return;
    clearInterval(this.timer);
    if (spanSink() === this) setSpanSink(undefined);
    const pending = async () => {
      while (this.queue.length > 0 || this.inflight.size > 0) {
        await this.flush();
        await Promise.allSettled([...this.inflight]);
      }
    };
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      pending(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, this.timeoutMs);
        deadline.unref();
      }),
    ]);
    clearTimeout(deadline);
  }
}
