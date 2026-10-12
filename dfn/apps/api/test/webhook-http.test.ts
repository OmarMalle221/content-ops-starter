import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrivateDestinationError,
  guardedLookup,
  postWebhook,
} from '../src/modules/api-platform/webhook-http';

/**
 * Webhook transport: the socket's own DNS lookup refuses private addresses (no DNS-rebinding window
 * between the dispatch-time check and the connection), redirects are not followed, and the whole
 * exchange is bounded by the timeout.
 */
describe('webhook transport', () => {
  let server: Server;
  let port: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }).end();
      } else if (req.url === '/slow') {
        setTimeout(() => res.writeHead(200).end('late'), 2_000).unref();
      } else {
        res.writeHead(204).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('refuses at connect time a name that resolves to a private address', async () => {
    const lookupError = await new Promise<Error | null>((resolve) =>
      guardedLookup('localhost', {}, (err) => resolve(err)),
    );
    expect(lookupError).toBeInstanceOf(PrivateDestinationError);

    hits.length = 0;
    const refused = await postWebhook(`http://localhost:${port}/hook`, {}, '{}', 2_000, true).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PrivateDestinationError);
    expect(hits).toHaveLength(0);
  });

  it('returns the status without following redirects, and bounds the exchange', async () => {
    expect(await postWebhook(`http://127.0.0.1:${port}/hook`, { 'X-Test': '1' }, '{}', 2_000, false)).toBe(
      204,
    );
    hits.length = 0;
    expect(await postWebhook(`http://127.0.0.1:${port}/redirect`, {}, '{}', 2_000, false)).toBe(302);
    expect(hits).toEqual(['/redirect']);
    const slow = await postWebhook(`http://127.0.0.1:${port}/slow`, {}, '{}', 200, false).catch(
      (e: unknown) => e,
    );
    expect((slow as Error).name).toBe('AbortError');
  });
});
