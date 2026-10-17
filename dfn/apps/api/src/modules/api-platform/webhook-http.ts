import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { TRACEPARENT_HEADER, outgoingTraceparent } from '../observability/trace-context';
import { isPrivateIpv4, isPrivateIpv6 } from './ssrf';

/** Raised when the connection would reach a private address (checked at connect time). */
export class PrivateDestinationError extends Error {
  constructor(host: string) {
    super(`Destination refused: host ${host} resolves to a private address`);
    this.name = 'PrivateDestinationError';
  }
}

/**
 * DNS lookup used by the webhook socket itself: every address is checked and the connection uses
 * exactly the addresses that passed. A name that resolves to a public address for the
 * dispatch-time check and to a private one a moment later (DNS rebinding) is refused here.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const opts: LookupOptions = { ...(options as LookupOptions), all: true, verbatim: true };
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    if (
      addresses.length === 0 ||
      addresses.some((a) => (a.family === 6 ? isPrivateIpv6(a.address) : isPrivateIpv4(a.address)))
    ) {
      return callback(new PrivateDestinationError(hostname), '', 0);
    }
    if ((options as LookupOptions).all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    const first = addresses[0]!;
    return callback(null, first.address, first.family);
  });
};

/**
 * POSTs a webhook body and resolves with the HTTP status (the response body is drained and
 * discarded). Redirects are never followed. The whole exchange — connection, request and response
 * body — is bounded by `timeoutMs`; on expiry the request is destroyed with an `AbortError`.
 * `guardPrivate` (every environment but tests) checks the resolved addresses at connect time.
 * Unless the caller set one, a `traceparent` header continues the current trace (a child span of
 * the request that produced the event) or starts a new one (retries run by the scheduler).
 */
export function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  guardPrivate: boolean,
): Promise<number> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, status?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(status ?? 0);
    };
    const req = send(
      target,
      {
        method: 'POST',
        headers: {
          [TRACEPARENT_HEADER]: outgoingTraceparent(),
          ...headers,
          'Content-Length': String(Buffer.byteLength(body)),
        },
        ...(guardPrivate ? { lookup: guardedLookup } : {}),
      },
      (res) => {
        res.on('error', (err) => finish(err));
        res.on('end', () => finish(null, res.statusCode ?? 0));
        res.resume();
      },
    );
    const deadline = setTimeout(() => {
      const abort = new Error(`Timeout after ${timeoutMs} ms`);
      abort.name = 'AbortError';
      req.destroy(abort);
      finish(abort);
    }, timeoutMs);
    req.on('error', (err) => finish(err));
    req.end(body);
  });
}
