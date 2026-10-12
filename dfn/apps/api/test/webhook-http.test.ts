import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/bootstrap';
import { isPlaceholderSecret, loadEnv } from '../src/config/env';
import { requestMeta } from '../src/common/request-meta';
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

describe('TRUST_PROXY parsing', () => {
  it('reads subnet lists, hop counts and booleans', () => {
    expect(parseTrustProxy('loopback,linklocal,uniquelocal')).toEqual([
      'loopback',
      'linklocal',
      'uniquelocal',
    ]);
    expect(parseTrustProxy(' loopback , 10.0.0.0/8 ')).toEqual(['loopback', '10.0.0.0/8']);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
  });
});

describe('requestMeta', () => {
  // The Express instance Nest itself runs on (express is not a direct dependency of the API).
  const nestRequire = createRequire(createRequire(__filename).resolve('@nestjs/platform-express'));
  const express = nestRequire('express') as () => Express;
  const appWith = (trustProxy: string) => {
    const app = express();
    app.set('trust proxy', parseTrustProxy(trustProxy));
    app.get('/', (req, res) => {
      res.json(requestMeta(req));
    });
    return app;
  };
  const spoofed = { 'X-Forwarded-For': '203.0.113.9, 198.51.100.1' };

  it('reads X-Forwarded-For through trusted peers only, never its client-chosen leftmost entry', async () => {
    // Trusted loopback peer: the closest untrusted hop it reports, not the leftmost spoof.
    expect((await request(appWith('loopback')).get('/').set(spoofed)).body.ip).toBe('198.51.100.1');
    // No trusted proxy: the socket address, whatever the header says.
    expect((await request(appWith('false')).get('/').set(spoofed)).body.ip).toMatch(/127\.0\.0\.1$/);
  });
});

describe('sample secrets', () => {
  it('refuses the .env.example placeholders in production only', () => {
    expect(isPlaceholderSecret('change-me-generate-64-hex-chars')).toBe(true);
    expect(isPlaceholderSecret('0'.repeat(64))).toBe(true);
    expect(isPlaceholderSecret('8f'.repeat(32))).toBe(false);
    expect(isPlaceholderSecret(undefined)).toBe(false);
    const samples = {
      SESSION_SECRET: 'change-me-generate-64-hex-chars',
      DOCUMENT_ENCRYPTION_KEY: '0'.repeat(64),
    };
    expect(() => loadEnv({ ...samples, NODE_ENV: 'production' })).toThrow(
      /SESSION_SECRET is a sample value[\s\S]*DOCUMENT_ENCRYPTION_KEY is a sample value/,
    );
    expect(() => loadEnv({ ...samples, NODE_ENV: 'test' })).not.toThrow();
    loadEnv();
  });
});
