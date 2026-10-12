import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal JSON-over-HTTP client shared by the FX and payout reference adapters (same contract as
 * packages/compliance/src/kyc/reference-http.ts — the packages do not depend on each other).
 *
 * Contract-test infrastructure only: the reference adapters are never constructed by the
 * factories, so nothing in the API ever reaches a partner over the network.
 *
 *  - `Authorization: Bearer <apiKey>` on every call, `Idempotency-Key` on every POST;
 *  - per-attempt timeout (AbortController), bounded retries with exponential back-off on
 *    429 / 5xx / timeouts / network errors — POSTs are retried only with an idempotency key,
 *    which stays identical across attempts;
 *  - HTTP status → stable `PartnerCallError.code` mapping, oversize / non-JSON bodies refused;
 *  - plain http:// is refused except on loopback hosts (local mock servers in tests).
 */

export type PartnerErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BAD_RESPONSE'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_EXPIRED'
  | 'CONFIGURATION'
  /** FX only: the quoted rate is older than the freshness window (or future-dated). */
  | 'STALE_RATE'
  /** FX only: zero, negative, malformed, out-of-bounds or off-reference rate. */
  | 'INVALID_RATE';

export class PartnerCallError extends Error {
  constructor(
    readonly code: PartnerErrorCode,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number,
    readonly attempts?: number,
  ) {
    super(message);
    this.name = 'PartnerCallError';
  }
}

export interface ReferenceHttpOptions {
  /** https:// base URL of the partner API (http:// only for loopback mock servers). */
  baseUrl: string;
  apiKey: string;
  /** Per-attempt timeout. Default 5 000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures. Default 2. */
  maxRetries?: number;
  /** First back-off delay, doubled at each retry. Default 200 ms. */
  retryBaseDelayMs?: number;
  /** Upper bound of any back-off, Retry-After included. Default 5 000 ms. */
  maxRetryDelayMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RESPONSE_CHARS = 1_000_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function assertPartnerBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PartnerCallError('CONFIGURATION', `Invalid partner base URL: ${baseUrl}`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  throw new PartnerCallError('CONFIGURATION', 'Partner base URL must use https:// (http only on loopback)');
}

export class ReferenceHttpClient {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ReferenceHttpOptions) {
    this.base = assertPartnerBaseUrl(options.baseUrl);
    if (!options.apiKey || options.apiKey.trim().length < 8) {
      throw new PartnerCallError('CONFIGURATION', 'Partner API key missing or too short');
    }
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 200;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body: unknown, idempotencyKey: string): Promise<unknown> {
    return this.request('POST', path, body, idempotencyKey);
  }

  private url(path: string): string {
    const prefix = this.base.pathname.replace(/\/+$/, '');
    return new URL(`${prefix}${path}`, this.base).toString();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const canRetry = method === 'GET' || Boolean(idempotencyKey);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.once(method, path, body, idempotencyKey);
      } catch (e) {
        const err =
          e instanceof PartnerCallError ? e : new PartnerCallError('NETWORK', (e as Error).message, true);
        if (!err.retryable || !canRetry || attempt > this.maxRetries) {
          throw new PartnerCallError(err.code, err.message, err.retryable, err.httpStatus, attempt);
        }
        const retryAfterMs = (err as PartnerCallError & { retryAfterMs?: number }).retryAfterMs;
        const backoff = retryAfterMs ?? this.retryBaseDelayMs * 2 ** (attempt - 1);
        await this.sleep(Math.min(backoff, this.maxRetryDelayMs));
      }
    }
  }

  private async once(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
          'User-Agent': 'dfn-reference-adapter/1 (sandbox contract tests)',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      text = await res.text();
    } catch (e) {
      if (controller.signal.aborted) {
        throw new PartnerCallError('TIMEOUT', `Partner call timed out after ${this.timeoutMs} ms`, true);
      }
      throw new PartnerCallError('NETWORK', `Partner unreachable: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw httpError(res, text);
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new PartnerCallError('BAD_RESPONSE', 'Partner response too large', false, res.status);
    }
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PartnerCallError('BAD_RESPONSE', 'Partner response is not valid JSON', false, res.status);
    }
  }
}

function httpError(res: Response, text: string): PartnerCallError {
  const status = res.status;
  let detail = '';
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof parsed.message === 'string') detail = `: ${parsed.message.slice(0, 200)}`;
  } catch {
    /* non-JSON error bodies are not echoed */
  }
  if (status === 401 || status === 403) {
    return new PartnerCallError('AUTH_FAILED', `Partner refused the credentials (${status})`, false, status);
  }
  if (status === 404)
    return new PartnerCallError('NOT_FOUND', `Partner resource not found${detail}`, false, 404);
  if (status === 409) {
    return new PartnerCallError('CONFLICT', `Partner reported a conflict${detail}`, false, 409);
  }
  if (status === 429) {
    const err = new PartnerCallError('RATE_LIMITED', 'Partner rate limit reached', true, 429);
    // A missing or blank header must not read as "retry immediately" (Number(null) === 0).
    const header = res.headers.get('retry-after');
    const retryAfter = header !== null && header.trim() !== '' ? Number(header) : Number.NaN;
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      Object.assign(err, { retryAfterMs: retryAfter * 1000 });
    }
    return err;
  }
  if (status >= 500) {
    return new PartnerCallError('UNAVAILABLE', `Partner unavailable (${status})`, true, status);
  }
  return new PartnerCallError(
    'INVALID_REQUEST',
    `Partner rejected the request (${status})${detail}`,
    false,
    status,
  );
}

// ── Signed webhooks ────────────────────────────────────────────────────────────────────────────

/** A webhook as received: raw body (exact bytes as text) and the two signature headers. */
export interface SignedWebhook {
  rawBody: string;
  /** `X-Reference-Timestamp`: unix seconds. */
  timestamp: string;
  /** `X-Reference-Signature`: `v1=<hex>` (several comma-separated values allowed during rotation). */
  signature: string;
}

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** `v1=` + hex HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function signReferenceWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/**
 * Verifies the HMAC (constant time) then the timestamp tolerance. Throws SIGNATURE_INVALID for a
 * malformed / tampered message and SIGNATURE_EXPIRED for a correctly signed but stale (or
 * future-dated) one — protection against replays.
 */
export function verifyReferenceWebhook(
  secret: string,
  webhook: SignedWebhook,
  options: { toleranceSeconds?: number; now?: Date } = {},
): void {
  if (!/^\d{1,12}$/.test(webhook.timestamp)) {
    throw new PartnerCallError('SIGNATURE_INVALID', 'Missing or malformed webhook timestamp');
  }
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${webhook.timestamp}.${webhook.rawBody}`).digest('hex'),
    'hex',
  );
  const candidates = webhook.signature
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1='))
    .map((s) => s.slice(3));
  const valid = candidates.some((hex) => {
    if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new PartnerCallError('SIGNATURE_INVALID', 'Webhook signature mismatch');
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(webhook.timestamp)) > tolerance) {
    throw new PartnerCallError('SIGNATURE_EXPIRED', `Webhook timestamp outside the ${tolerance} s tolerance`);
  }
}

/** Stable idempotency key: same operation and payload → same key across retries and restarts. */
export function idempotencyKeyFor(operation: string, payload: unknown): string {
  return `dfn-${operation}-${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40)}`;
}

/** Parses a JSON value expected to be an object. */
export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PartnerCallError('BAD_RESPONSE', `Partner ${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string, what: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
    throw new PartnerCallError('BAD_RESPONSE', `Partner ${what} has no valid "${key}"`);
  }
  return v;
}
