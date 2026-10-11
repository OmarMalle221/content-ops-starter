import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A request as received by the in-process mock partner. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  rawBody: string;
  json: any;
}

export interface MockReply {
  status: number;
  body?: unknown;
  /** Sent verbatim instead of JSON.stringify(body). */
  raw?: string;
  headers?: Record<string, string>;
  /** Delay before replying (to exercise client timeouts). */
  delayMs?: number;
}

export type MockHandler = (req: RecordedRequest, index: number) => MockReply | Promise<MockReply>;

export interface MockPartner {
  baseUrl: string;
  requests: RecordedRequest[];
  setHandler(handler: MockHandler): void;
  close(): Promise<void>;
}

/**
 * Programmable partner API on 127.0.0.1 (random port) built on node:http. Every request is
 * recorded (method, path, query, headers, raw body) so contract tests can assert request shapes.
 */
export async function startMockPartner(initial: MockHandler): Promise<MockPartner> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json: unknown = undefined;
      try {
        json = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        json = undefined;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        rawBody,
        json,
      };
      requests.push(recorded);
      void Promise.resolve(handler(recorded, requests.length - 1)).then((reply) => {
        const send = () => write(res, reply);
        if (reply.delayMs) {
          const t = setTimeout(() => {
            timers.delete(t);
            send();
          }, reply.delayMs);
          timers.add(t);
        } else {
          send();
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setHandler(h) {
      handler = h;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function write(res: ServerResponse, reply: MockReply) {
  if (res.destroyed || res.writableEnded) return;
  const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
  res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
  res.end(payload);
}
