import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, parseOtlpHeaders } from '../src/config/env';
import { postWebhook } from '../src/modules/api-platform/webhook-http';
import { MetricsService } from '../src/modules/observability/metrics.service';
import { setSpanSink, spanSink, type SpanRecord } from '../src/modules/observability/span-recorder';
import { runWithTraceContext, type TraceContext } from '../src/modules/observability/trace-context';
import {
  SPAN_BATCH_SIZE,
  SPAN_QUEUE_LIMIT,
  TraceExporterService,
  encodeOtlpTraces,
} from '../src/modules/observability/trace-exporter.service';
import { bootTestApp, type TestContext } from './helpers/app';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number; message?: string };
}

/** OTLP/HTTP collector double: records each export request; `mode` decides the answer. */
class Collector {
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = [];
  mode: 'ok' | 'error' | 'hang' | { rejected: number } = 'ok';
  private server!: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.requests.push({
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        if (this.mode === 'hang') return;
        if (this.mode === 'error') {
          res.writeHead(503).end();
          return;
        }
        const rejected = typeof this.mode === 'object' ? this.mode.rejected : 0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rejected ? JSON.stringify({ partialSuccess: { rejectedSpans: rejected } }) : '{}');
      });
    });
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((done) => this.server.close(() => done()));
  }

  spans(): OtlpSpan[] {
    return this.requests.flatMap((r) => spansIn(r.body));
  }
}

function spansIn(body: string): OtlpSpan[] {
  return (
    JSON.parse(body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> }
  ).resourceSpans
    .flatMap((rs) => rs.scopeSpans)
    .flatMap((ss) => ss.spans);
}

const attrs = (span: OtlpSpan) =>
  Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

function span(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'GET /v1/health',
    kind: 'SERVER',
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_000_250_000_000n,
    attributes: {},
    ...overrides,
  };
}

function exporterFor(endpoint: string, extra: Record<string, string> = {}) {
  const env = loadEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TIMEOUT: '2000',
    ...extra,
  });
  const metrics = new MetricsService(env);
  return { exporter: new TraceExporterService(env, metrics), metrics };
}

const metricValue = async (metrics: MetricsService, name: string, reason?: string) => {
  const metric = await metrics.registry.getSingleMetric(name)?.get();
  return metric?.values.find((v) => (reason ? v.labels.reason === reason : true))?.value ?? 0;
};

describe('OTLP encoding and configuration', () => {
  it('encodes spans as OTLP/JSON: hex ids, string nanoseconds, kinds, typed attributes, status', () => {
    const body = encodeOtlpTraces(
      [
        span({
          parentSpanId: 'c'.repeat(16),
          attributes: { 'http.route': '/v1/health', 'http.response.status_code': 200, ok: true, ratio: 0.5 },
        }),
        span({ spanId: 'd'.repeat(16), kind: 'CLIENT', name: 'POST webhook', error: 'HTTP 500' }),
      ],
      { 'service.name': 'dfn-api' },
      'dfn-api',
    );
    const [server, client] = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(body.resourceSpans[0]!.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'dfn-api' } },
    ]);
    expect(server).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      kind: 2,
      startTimeUnixNano: '1700000000000000000',
      endTimeUnixNano: '1700000000250000000',
      status: { code: 0 },
    });
    expect(server!.attributes).toEqual([
      { key: 'http.route', value: { stringValue: '/v1/health' } },
      { key: 'http.response.status_code', value: { intValue: '200' } },
      { key: 'ok', value: { boolValue: true } },
      { key: 'ratio', value: { doubleValue: 0.5 } },
    ]);
    expect(client).toMatchObject({ kind: 3, status: { code: 2, message: 'HTTP 500' } });
    expect(client).not.toHaveProperty('parentSpanId');
  });

  it('parses OTEL_EXPORTER_OTLP_HEADERS and refuses malformed values without echoing them', () => {
    expect(parseOtlpHeaders('Authorization=Bearer%20s3cr3t, x-team = dfn')).toEqual({
      authorization: 'Bearer s3cr3t',
      'x-team': 'dfn',
    });
    expect(parseOtlpHeaders('no-equals-sign')).toBeNull();
    expect(parseOtlpHeaders('bad key=v')).toBeNull();
    expect(() => loadEnv({ OTEL_EXPORTER_OTLP_HEADERS: 'tok3n-without-key' })).toThrow(
      /OTEL_EXPORTER_OTLP_HEADERS/,
    );
    expect(() => loadEnv({ OTEL_EXPORTER_OTLP_HEADERS: 'tok3n-without-key' })).not.toThrow(/tok3n/);
    expect(() => loadEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector' })).toThrow(/http\(s\) URL/);
    expect(loadEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }).OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    loadEnv();
  });
});

describe('TraceExporterService', () => {
  const collector = new Collector();
  beforeAll(() => collector.start());
  afterAll(() => collector.stop());
  afterEach(() => {
    collector.requests.length = 0;
    collector.mode = 'ok';
    setSpanSink(undefined);
    loadEnv();
  });

  it('is off without an endpoint: no sink installed', () => {
    const env = loadEnv();
    const exporter = new TraceExporterService(env, new MetricsService(env));
    exporter.onModuleInit();
    expect(exporter.enabled).toBe(false);
    expect(spanSink()).toBeUndefined();
  });

  it('posts batches to <endpoint>/v1/traces with the configured headers and counts them', async () => {
    const { exporter, metrics } = exporterFor(`${collector.url}/`, {
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20collector-token',
    });
    exporter.onModuleInit();
    expect(spanSink()).toBe(exporter);
    for (let i = 0; i < 3; i++) exporter.record(span({ spanId: String(i).repeat(16) }));
    await exporter.flush();
    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0]).toMatchObject({
      path: '/v1/traces',
      headers: { authorization: 'Bearer collector-token', 'content-type': 'application/json' },
    });
    expect(collector.spans()).toHaveLength(3);
    expect(await metricValue(metrics, 'dfn_trace_spans_exported_total')).toBe(3);
    await exporter.onApplicationShutdown();
    expect(spanSink()).toBeUndefined();
  });

  it('uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT as is', async () => {
    const { exporter } = exporterFor('http://unused.invalid', {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/custom/traces`,
    });
    exporter.record(span());
    await exporter.flush();
    expect(collector.requests[0]!.path).toBe('/custom/traces');
  });

  it('sends a full batch at once and splits a backlog into batches', async () => {
    const { exporter } = exporterFor(collector.url);
    for (let i = 0; i < SPAN_BATCH_SIZE * 2 + 1; i++) exporter.record(span());
    await exporter.onApplicationShutdown();
    const sizes = collector.requests.map((r) => spansIn(r.body).length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, SPAN_BATCH_SIZE, SPAN_BATCH_SIZE]);
  });

  it('drops (and counts) spans the collector refuses or partially rejects, without throwing', async () => {
    const { exporter, metrics } = exporterFor(collector.url);
    collector.mode = 'error';
    exporter.record(span());
    exporter.record(span());
    await exporter.flush();
    expect(await metricValue(metrics, 'dfn_trace_spans_dropped_total', 'export_failed')).toBe(2);
    collector.mode = { rejected: 1 };
    exporter.record(span());
    exporter.record(span());
    await exporter.flush();
    expect(await metricValue(metrics, 'dfn_trace_spans_dropped_total', 'rejected')).toBe(1);
    expect(await metricValue(metrics, 'dfn_trace_spans_exported_total')).toBe(1);
  });

  it('counts an unreachable collector as export_failed', async () => {
    const { exporter, metrics } = exporterFor('http://127.0.0.1:1');
    exporter.record(span());
    await exporter.flush();
    expect(await metricValue(metrics, 'dfn_trace_spans_dropped_total', 'export_failed')).toBe(1);
  });

  it('bounds the queue: with the collector stuck, spans beyond the limit are dropped, not buffered', async () => {
    const { exporter, metrics } = exporterFor(collector.url, { OTEL_EXPORTER_OTLP_TIMEOUT: '500' });
    collector.mode = 'hang';
    const total = SPAN_QUEUE_LIMIT + 2 * SPAN_BATCH_SIZE + 10;
    for (let i = 0; i < total; i++) exporter.record(span());
    // Two batches in flight (stuck), the queue full, the rest dropped.
    expect(await metricValue(metrics, 'dfn_trace_spans_dropped_total', 'queue_full')).toBe(10);
    await exporter.onApplicationShutdown();
  });
});

describe('spans of HTTP requests (application)', () => {
  const collector = new Collector();
  let ctx: TestContext;
  let exporter: TraceExporterService;
  beforeAll(async () => {
    await collector.start();
    ctx = await bootTestApp({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url });
    exporter = ctx.app.get(TraceExporterService);
  });
  afterAll(async () => {
    await ctx?.close();
    await collector.stop();
    loadEnv();
  });
  afterEach(() => {
    collector.requests.length = 0;
  });

  it('exports the server span of a request with the ids of its traceparent, continuing the caller', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentId = '00f067aa0ba902b7';
    const res = await ctx
      .http()
      .get('/v1/health?token=query-secret-value')
      .set('traceparent', `00-${traceId}-${parentId}-01`)
      .set('X-Request-Id', 'req-trace-export-1');
    expect(res.status).toBe(200);
    const [, , spanId] = TRACEPARENT.exec(res.headers.traceparent as string)!;
    await exporter.flush();
    const exported = collector.spans().find((s) => s.spanId === spanId);
    expect(exported).toMatchObject({
      traceId,
      parentSpanId: parentId,
      name: 'GET /v1/health',
      kind: 2,
      status: { code: 0 },
    });
    expect(attrs(exported!)).toEqual({
      'http.request.method': 'GET',
      'http.route': '/v1/health',
      'http.response.status_code': '200',
      'dfn.request_id': 'req-trace-export-1',
    });
    expect(BigInt(exported!.endTimeUnixNano)).toBeGreaterThan(BigInt(exported!.startTimeUnixNano));
    // Route template only: the query string never leaves the process.
    expect(collector.requests.map((r) => r.body).join('')).not.toContain('query-secret-value');
    const resource = (
      JSON.parse(collector.requests[0]!.body) as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        }>;
      }
    ).resourceSpans[0]!.resource.attributes;
    expect(Object.fromEntries(resource.map((a) => [a.key, a.value.stringValue]))).toMatchObject({
      'service.name': 'dfn-api',
      'deployment.environment.name': 'sandbox',
      'dfn.mode': 'sandbox',
    });
  });

  it('names unmatched routes with the fixed label and does not export unsampled traces', async () => {
    const notFound = await ctx.http().get('/v1/no-such-route/1234');
    expect(notFound.status).toBe(404);
    const unsampled = await ctx
      .http()
      .get('/v1/health')
      .set('traceparent', `00-${'5'.repeat(32)}-${'6'.repeat(16)}-00`);
    await exporter.flush();
    const names = collector.spans().map((s) => s.name);
    expect(names).toContain('GET unmatched');
    expect(names.join(' ')).not.toContain('no-such-route');
    expect(collector.spans().some((s) => s.traceId === '5'.repeat(32))).toBe(false);
    expect(unsampled.headers.traceparent).toMatch(/-00$/);
  });
});

describe('client spans of webhook deliveries', () => {
  const collector = new Collector();
  let partner: Server;
  let partnerUrl = '';
  let received: IncomingHttpHeaders[] = [];
  let partnerStatus = 200;
  let exporter: TraceExporterService;
  beforeAll(async () => {
    await collector.start();
    partner = createServer((req, res) => {
      received.push(req.headers);
      req.resume();
      req.on('end', () => res.writeHead(partnerStatus).end());
    });
    await new Promise<void>((done) => partner.listen(0, '127.0.0.1', done));
    partnerUrl = `http://127.0.0.1:${(partner.address() as AddressInfo).port}/hooks/abc?key=partner-secret`;
    exporter = exporterFor(collector.url).exporter;
    exporter.onModuleInit();
  });
  afterAll(async () => {
    await exporter.onApplicationShutdown();
    await new Promise<void>((done) => partner.close(() => done()));
    await collector.stop();
    loadEnv();
  });
  afterEach(() => {
    collector.requests.length = 0;
    received = [];
    partnerStatus = 200;
  });

  it('records a child span whose id is the one sent in traceparent, without the URL path or query', async () => {
    const parent: TraceContext = { traceId: '7'.repeat(32), spanId: '8'.repeat(16), flags: '01' };
    const status = await runWithTraceContext(parent, () =>
      postWebhook(partnerUrl, { 'X-DFN-Event': 'transaction.created' }, '{}', 2000, false, {
        'dfn.webhook.event_type': 'transaction.created',
        'dfn.webhook.attempt': 1,
      }),
    );
    expect(status).toBe(200);
    const [, traceId, spanId] = TRACEPARENT.exec(received[0]!.traceparent as string)!;
    await exporter.flush();
    const [client] = collector.spans();
    expect(client).toMatchObject({
      traceId,
      spanId,
      parentSpanId: parent.spanId,
      name: 'POST webhook',
      kind: 3,
      status: { code: 0 },
    });
    expect(traceId).toBe(parent.traceId);
    expect(attrs(client!)).toEqual({
      'dfn.webhook.event_type': 'transaction.created',
      'dfn.webhook.attempt': '1',
      'http.request.method': 'POST',
      'server.address': '127.0.0.1',
      'http.response.status_code': '200',
    });
    const body = collector.requests.map((r) => r.body).join('');
    expect(body).not.toContain('partner-secret');
    expect(body).not.toContain('/hooks/abc');
  });

  it('marks refused and failed deliveries as errors; a root span outside any request', async () => {
    partnerStatus = 500;
    expect(await postWebhook(partnerUrl, {}, '{}', 2000, false)).toBe(500);
    await expect(postWebhook('http://127.0.0.1:1/hook', {}, '{}', 2000, false)).rejects.toThrow();
    await exporter.flush();
    const [refused, failed] = collector.spans();
    expect(refused).toMatchObject({ status: { code: 2, message: 'HTTP 500' } });
    expect(refused).not.toHaveProperty('parentSpanId');
    expect(failed).toMatchObject({ status: { code: 2 } });
    expect(attrs(failed!)).not.toHaveProperty('http.response.status_code');
  });

  it('records nothing when the caller supplies its own traceparent', async () => {
    await postWebhook(
      partnerUrl,
      { traceparent: `00-${'9'.repeat(32)}-${'a'.repeat(16)}-01` },
      '{}',
      2000,
      false,
    );
    await exporter.flush();
    expect(received[0]!.traceparent).toBe(`00-${'9'.repeat(32)}-${'a'.repeat(16)}-01`);
    expect(collector.spans()).toHaveLength(0);
  });
});
