import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) without a tracing backend: every
 * request gets a trace id (continued from a valid incoming `traceparent`, or new) and a span id of
 * its own; both are echoed in the `traceparent` response header, written on every log line of the
 * request (pino customProps, app.module.ts) and continued by outgoing webhook requests (child span).
 * Plain module (no Nest dependency) so that transports such as webhook-http.ts can import it.
 */
export interface TraceContext {
  /** 32 lowercase hex characters, never all zeros. */
  traceId: string;
  /** Span of this request (16 lowercase hex characters). */
  spanId: string;
  /** parent-id of the incoming traceparent, when the trace was continued. */
  parentSpanId?: string;
  /** Trace flags, "01" (sampled) or "00". */
  flags: string;
}

export const TRACEPARENT_HEADER = 'traceparent';

const HEX = /^[0-9a-f]+$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
/** New traces are flagged sampled: every request is recorded, in the logs at least. */
const NEW_TRACE_FLAGS = '01';

export interface ParsedTraceparent {
  traceId: string;
  parentId: string;
  flags: string;
}

/**
 * Parses a traceparent header (W3C level 1 rules): version 00 must be exactly
 * `00-<32 hex>-<16 hex>-<2 hex>`; a higher version is read from its first four fields when the
 * rest is separated by "-" (forward compatibility); version ff, uppercase hex, all-zero ids and
 * repeated headers (joined with ", " by Node) are invalid. Returns null when invalid.
 */
export function parseTraceparent(header: string | string[] | undefined): ParsedTraceparent | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (value.length < 55) return null;
  const version = value.slice(0, 2);
  if (!HEX.test(version) || version === 'ff') return null;
  if (version === '00' ? value.length !== 55 : value.length > 55 && value[55] !== '-') return null;
  if (value[2] !== '-' || value[35] !== '-' || value[52] !== '-') return null;
  const traceId = value.slice(3, 35);
  const parentId = value.slice(36, 52);
  const flags = value.slice(53, 55);
  if (!HEX.test(traceId) || !HEX.test(parentId) || !HEX.test(flags)) return null;
  if (traceId === ZERO_TRACE_ID || parentId === ZERO_SPAN_ID) return null;
  return { traceId, parentId, flags };
}

export function formatTraceparent(traceId: string, spanId: string, flags: string): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

function randomHex(bytes: number, zero: string): string {
  for (;;) {
    const id = randomBytes(bytes).toString('hex');
    if (id !== zero) return id;
  }
}

export const newTraceId = () => randomHex(16, ZERO_TRACE_ID);
export const newSpanId = () => randomHex(8, ZERO_SPAN_ID);

/** Only the sampled bit is propagated: the other bits are undefined in version 00. */
function sampledBit(flags: string): string {
  return (parseInt(flags, 16) & 0x01) === 1 ? '01' : '00';
}

/** A server span continuing `incoming` (a valid parsed header), or the root span of a new trace. */
export function serverTraceContext(incoming: ParsedTraceparent | null): TraceContext {
  if (!incoming) return { traceId: newTraceId(), spanId: newSpanId(), flags: NEW_TRACE_FLAGS };
  return {
    traceId: incoming.traceId,
    spanId: newSpanId(),
    parentSpanId: incoming.parentId,
    flags: sampledBit(incoming.flags),
  };
}

const byRequest = new WeakMap<IncomingMessage, TraceContext>();

/**
 * Trace context of an HTTP request, created on first use and memoised on the request object:
 * pino-http (customProps) and the observability middleware may run in either order and always
 * see the same ids. With `res`, the `traceparent` response header is set (once, before headers
 * are sent).
 */
export function traceContextFor(req: IncomingMessage, res?: ServerResponse): TraceContext {
  let ctx = byRequest.get(req);
  if (!ctx) {
    ctx = serverTraceContext(parseTraceparent(req.headers[TRACEPARENT_HEADER]));
    byRequest.set(req, ctx);
  }
  if (res && !res.headersSent && !res.hasHeader(TRACEPARENT_HEADER)) {
    res.setHeader(TRACEPARENT_HEADER, formatTraceparent(ctx.traceId, ctx.spanId, ctx.flags));
  }
  return ctx;
}

/** Fields written on every log line of a request (pino-http customProps). */
export function traceLogFields(
  req: IncomingMessage,
  res: ServerResponse,
): { trace_id: string; span_id: string } {
  const ctx = traceContextFor(req, res);
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Runs `fn` (and every asynchronous continuation it starts) inside `ctx`. */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Trace context of the current request, or undefined outside one (scheduled jobs, boot). */
export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * `traceparent` for an outgoing request: a new child span of the current trace, or the root span
 * of a new trace outside any request (e.g. webhook retries run by the scheduler).
 */
export function outgoingTraceparent(parent: TraceContext | undefined = currentTraceContext()): string {
  return parent
    ? formatTraceparent(parent.traceId, newSpanId(), parent.flags)
    : formatTraceparent(newTraceId(), newSpanId(), NEW_TRACE_FLAGS);
}
