/**
 * Finished spans of this process, handed to the exporter when one is configured
 * (trace-exporter.service.ts, OTEL_EXPORTER_OTLP_*), dropped otherwise. The ids are those of
 * trace-context.ts — already logged and propagated — so exported spans match the logs and the
 * `traceparent` headers partners receive. Plain module (no Nest dependency), like trace-context.ts.
 *
 * Attributes are operational only: method, route template, status, request id, partner host, event
 * type. Never a raw URL or query string, a body, an address, a user or an amount.
 */
export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT';
export type SpanAttributeValue = string | number | boolean;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** Nanoseconds since the Unix epoch. */
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, SpanAttributeValue>;
  /** Error status (5xx answer, failed or refused delivery); unset otherwise. */
  error?: string;
}

export interface SpanSink {
  record(span: SpanRecord): void;
}

let sink: SpanSink | undefined;

/** Installs (or, with undefined, removes) the process-wide sink. */
export function setSpanSink(next: SpanSink | undefined) {
  sink = next;
}

export function spanSink(): SpanSink | undefined {
  return sink;
}

/** Whether finished spans go anywhere: callers skip building attributes otherwise. */
export function spanExportEnabled(): boolean {
  return sink !== undefined;
}

/**
 * Records a finished span when the trace is sampled (flags "01"; unsampled traces stay in the logs
 * only). Never throws: tracing must not break the request or the delivery it describes.
 */
export function recordSpan(span: SpanRecord, flags: string) {
  if (!sink || (parseInt(flags, 16) & 0x01) !== 1) return;
  try {
    sink.record(span);
  } catch {
    // The exporter counts its own failures; a broken sink must not reach the caller.
  }
}

const originNs = BigInt(Math.round(performance.timeOrigin * 1e6));

/** Wall-clock time in nanoseconds, monotonic within the process (performance.now()). */
export function nowUnixNano(): bigint {
  return originNs + BigInt(Math.round(performance.now() * 1e6));
}
