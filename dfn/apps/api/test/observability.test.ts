import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/config/env';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { postWebhook } from '../src/modules/api-platform/webhook-http';
import { WebhookDispatcherService } from '../src/modules/api-platform/webhook-dispatcher.service';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import {
  DomainGaugesService,
  withStatementTimeout,
} from '../src/modules/observability/domain-gauges.service';
import {
  bearerTokenMatches,
  isForwardedRequest,
  isLoopbackAddress,
  metricsAccess,
} from '../src/modules/observability/metrics-access';
import { MetricsService } from '../src/modules/observability/metrics.service';
import {
  DOCS_ROUTE,
  UNMATCHED_ROUTE,
  methodLabel,
  routeTemplate,
} from '../src/modules/observability/route-template';
import {
  currentTraceContext,
  formatTraceparent,
  outgoingTraceparent,
  parseTraceparent,
  runWithTraceContext,
  serverTraceContext,
  type TraceContext,
} from '../src/modules/observability/trace-context';
import { PASSWORD, bootTestApp, registerUser, resetDatabase, type TestContext } from './helpers/app';

const TOKEN = 'obs-test-metrics-token-0123456789abcdef';
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const repoFile = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8');

// ── Prometheus exposition text helpers ───────────────────────────────────────

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseSamples(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').match(/[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"/g) ?? []) {
      const eq = pair.indexOf('=');
      labels[pair.slice(0, eq)] = pair.slice(eq + 2, -1);
    }
    samples.push({ name: match[1]!, labels, value: Number(match[3]) });
  }
  return samples;
}

function sampleValue(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  return parseSamples(text).find(
    (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  )?.value;
}

/** Metric families declared by `# TYPE` lines, expanded to the sample names a histogram / summary emits. */
function exposedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (!match) continue;
    const [, name, type] = match;
    names.add(name!);
    if (type === 'histogram') ['_bucket', '_sum', '_count'].forEach((s) => names.add(`${name}${s}`));
    if (type === 'summary') ['_sum', '_count'].forEach((s) => names.add(`${name}${s}`));
  }
  return names;
}

// ── Minimal YAML subset parser (alerts.yml: mappings, sequences, scalars, block scalars) ──
// Neither `yaml` nor `js-yaml` is a dependency of the API, and the rules file is ours, so it is
// written in a regular subset: two-space indentation, `- key: value` items, `key: |` block scalars.

type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };
interface YamlLine {
  indent: number;
  text: string;
  raw: string;
  skip: boolean;
}

function yamlLines(source: string): YamlLine[] {
  return source.split('\n').map((raw) => {
    const text = raw.trim();
    return {
      raw,
      text,
      indent: raw.length - raw.trimStart().length,
      skip: text === '' || text.startsWith('#'),
    };
  });
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function nextContent(lines: YamlLine[], from: number): number {
  for (let i = from; i < lines.length; i++) if (!lines[i]!.skip) return i;
  return -1;
}

function parseNode(lines: YamlLine[], i: number, indent: number): [YamlValue, number] {
  return lines[i]!.text.startsWith('-') ? parseSequence(lines, i, indent) : parseMapping(lines, i, indent);
}

function parseSequence(lines: YamlLine[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.skip) {
      i++;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.text.startsWith('-'))
      throw new Error(`alerts.yml line ${i + 1}: expected "-"`);
    const rest = line.text.slice(1).trim();
    if (rest === '') {
      const j = nextContent(lines, i + 1);
      const [value, next] = parseNode(lines, j, lines[j]!.indent);
      items.push(value);
      i = next;
    } else if (/^[A-Za-z_][\w-]*:(\s|$)/.test(rest)) {
      // `- key: value`: the item is a mapping whose first key sits on the dash line (column indent + 2).
      lines[i] = { ...line, indent: indent + 2, text: rest };
      const [value, next] = parseMapping(lines, i, indent + 2);
      items.push(value);
      i = next;
    } else {
      items.push(unquote(rest));
      i++;
    }
  }
  return [items, i];
}

function parseMapping(
  lines: YamlLine[],
  start: number,
  indent: number,
): [{ [key: string]: YamlValue }, number] {
  const node: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.skip) {
      i++;
      continue;
    }
    if (line.indent < indent || (line.indent === indent && line.text.startsWith('-'))) break;
    if (line.indent !== indent) throw new Error(`alerts.yml line ${i + 1}: unexpected indentation`);
    const match = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line.text);
    if (!match) throw new Error(`alerts.yml line ${i + 1}: expected "key: value"`);
    const key = match[1]!;
    const inline = match[2]?.trim() ?? '';
    if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j]!.text === '' || lines[j]!.indent > indent))
        block.push(lines[j++]!.raw);
      while (block.length && block[block.length - 1]!.trim() === '') block.pop();
      const common = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      node[key] = block.map((l) => l.slice(common)).join('\n');
      i = j;
    } else if (inline === '') {
      const j = nextContent(lines, i + 1);
      if (j === -1 || lines[j]!.indent <= indent) {
        node[key] = '';
        i++;
      } else {
        const [value, next] = parseNode(lines, j, lines[j]!.indent);
        node[key] = value;
        i = next;
      }
    } else {
      node[key] = unquote(inline);
      i++;
    }
  }
  return [node, i];
}

function parseYamlSubset(source: string): YamlValue {
  const lines = yamlLines(source);
  const first = nextContent(lines, 0);
  return parseNode(lines, first, lines[first]!.indent)[0];
}

/** GitHub-style anchor of a Markdown heading (lowercase, punctuation dropped, spaces to hyphens). */
const headingAnchor = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('metrics access predicate', () => {
  it('recognises loopback peers only by their socket address', () => {
    for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:7f00:1']) {
      expect(isLoopbackAddress(ok), ok).toBe(true);
    }
    for (const no of [
      undefined,
      '',
      '10.0.0.1',
      '172.18.0.5',
      '::ffff:10.0.0.1',
      '128.0.0.1',
      '127.0.0',
      'localhost',
    ]) {
      expect(isLoopbackAddress(no), String(no)).toBe(false);
    }
  });

  it('without a token, allows direct loopback peers and refuses everyone else (403)', () => {
    expect(metricsAccess({ remoteAddress: '127.0.0.1' })).toBe('allowed');
    expect(metricsAccess({ remoteAddress: '::1', authorization: 'Bearer whatever' })).toBe('allowed');
    expect(metricsAccess({ remoteAddress: '172.18.0.5' })).toBe('forbidden');
    expect(metricsAccess({ remoteAddress: '172.18.0.5', authorization: 'Bearer anything' })).toBe(
      'forbidden',
    );
    expect(metricsAccess({})).toBe('forbidden');
    // A loopback peer that forwarded the request (the web app's /api rewrite on the same host, a
    // local reverse proxy) is not a local agent.
    expect(metricsAccess({ remoteAddress: '127.0.0.1', forwarded: true })).toBe('forbidden');
    expect(metricsAccess({ remoteAddress: '127.0.0.1', forwarded: false })).toBe('allowed');
  });

  it('recognises forwarded requests by the headers proxies add (Next.js sets X-Forwarded-Host)', () => {
    expect(isForwardedRequest({})).toBe(false);
    expect(isForwardedRequest({ host: 'localhost:4000', 'user-agent': 'curl' })).toBe(false);
    expect(isForwardedRequest({ 'x-forwarded-host': 'web.example' })).toBe(true);
    expect(isForwardedRequest({ 'x-forwarded-for': '203.0.113.9' })).toBe(true);
    expect(isForwardedRequest({ 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] })).toBe(true);
    expect(isForwardedRequest({ 'x-forwarded-proto': 'https' })).toBe(true);
    expect(isForwardedRequest({ 'x-real-ip': '203.0.113.9' })).toBe(true);
    expect(isForwardedRequest({ forwarded: 'for=203.0.113.9' })).toBe(true);
    expect(isForwardedRequest({ via: '1.1 proxy' })).toBe(true);
    // An empty value is not a forwarding.
    expect(isForwardedRequest({ 'x-forwarded-for': '' })).toBe(false);
  });

  it('with a token, forwarded requests are judged on the token alone', () => {
    expect(
      metricsAccess({
        token: TOKEN,
        remoteAddress: '127.0.0.1',
        forwarded: true,
        authorization: `Bearer ${TOKEN}`,
      }),
    ).toBe('allowed');
    expect(metricsAccess({ token: TOKEN, remoteAddress: '127.0.0.1', forwarded: true })).toBe('unauthorized');
  });

  it('with a token, requires exactly that bearer whatever the peer (401 otherwise)', () => {
    const token = TOKEN;
    expect(metricsAccess({ token, remoteAddress: '172.18.0.5', authorization: `Bearer ${token}` })).toBe(
      'allowed',
    );
    expect(metricsAccess({ token, remoteAddress: '172.18.0.5', authorization: `bearer ${token}` })).toBe(
      'allowed',
    );
    // Loopback does not bypass a configured token.
    expect(metricsAccess({ token, remoteAddress: '127.0.0.1' })).toBe('unauthorized');
    expect(metricsAccess({ token, remoteAddress: '127.0.0.1', authorization: `Bearer ${token}x` })).toBe(
      'unauthorized',
    );
    expect(metricsAccess({ token, authorization: `Bearer ${token.slice(1)}` })).toBe('unauthorized');
    expect(metricsAccess({ token, authorization: `Basic ${token}` })).toBe('unauthorized');
    expect(metricsAccess({ token, authorization: token })).toBe('unauthorized');
    expect(bearerTokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(bearerTokenMatches(`Bearer ${token}`, '')).toBe(false);
    expect(bearerTokenMatches(undefined, token)).toBe(false);
  });
});

describe('HTTP metric labels', () => {
  it('uses the matched route template, never the URL, and fixed names otherwise', () => {
    expect(routeTemplate({ route: { path: '/v1/transfers/:id' }, path: '/v1/transfers/abc-123' })).toBe(
      '/v1/transfers/:id',
    );
    expect(routeTemplate({ route: { path: ['/v1/a/:id', '/v1/b/:id'] }, baseUrl: '' })).toBe('/v1/a/:id');
    expect(routeTemplate({ route: { path: '/v1/x' }, baseUrl: '/base' })).toBe('/base/v1/x');
    expect(routeTemplate({ path: '/v1/transfers/9f1c0b3e-0000-4000-8000-000000000000' })).toBe(
      UNMATCHED_ROUTE,
    );
    expect(routeTemplate({ path: '/docs' })).toBe(DOCS_ROUTE);
    expect(routeTemplate({ path: '/docs/swagger-ui.css' })).toBe(DOCS_ROUTE);
    expect(routeTemplate({ path: '/docs-json' })).toBe(DOCS_ROUTE);
    expect(routeTemplate({ path: '/documents' })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ route: { path: '/v1/x' } }, '/metrics')).toBe('/metrics');
    // Nest mounts middleware as routes: the instrumentation's own route means "no controller route".
    const own = { path: '/{*path}' };
    expect(routeTemplate({ route: own, path: '/v1/unknown' }, undefined, own)).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ route: own, path: '/docs/x.js' }, undefined, own)).toBe(DOCS_ROUTE);
    expect(routeTemplate({ route: { path: '/v1/y' }, path: '/v1/y' }, undefined, own)).toBe('/v1/y');
    expect(methodLabel('get')).toBe('GET');
    expect(methodLabel('PROPFIND')).toBe('OTHER');
    expect(methodLabel(undefined)).toBe('OTHER');
  });
});

describe('W3C traceparent', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parentId = '00f067aa0ba902b7';

  it('parses valid headers and rejects malformed ones', () => {
    expect(parseTraceparent(`00-${traceId}-${parentId}-01`)).toEqual({ traceId, parentId, flags: '01' });
    expect(parseTraceparent(`  00-${traceId}-${parentId}-00 `)).toEqual({ traceId, parentId, flags: '00' });
    // A future version with extra fields is read from its first four fields.
    expect(parseTraceparent(`01-${traceId}-${parentId}-01-extra`)).toEqual({
      traceId,
      parentId,
      flags: '01',
    });
    for (const bad of [
      undefined,
      '',
      `00-${traceId}-${parentId}`,
      `00-${traceId}-${parentId}-01-extra`,
      `00-${traceId.toUpperCase()}-${parentId}-01`,
      `00-${'0'.repeat(32)}-${parentId}-01`,
      `00-${traceId}-${'0'.repeat(16)}-01`,
      `ff-${traceId}-${parentId}-01`,
      `00_${traceId}-${parentId}-01`,
      `00-${traceId}-${parentId}-0g`,
      [`00-${traceId}-${parentId}-01`, `00-${traceId}-${parentId}-01`],
    ]) {
      expect(parseTraceparent(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('continues an incoming trace with a new span, or starts a new sampled trace', () => {
    const continued = serverTraceContext({ traceId, parentId, flags: '01' });
    expect(continued.traceId).toBe(traceId);
    expect(continued.parentSpanId).toBe(parentId);
    expect(continued.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(continued.spanId).not.toBe(parentId);
    expect(continued.flags).toBe('01');
    // Only the sampled bit is propagated.
    expect(serverTraceContext({ traceId, parentId, flags: 'fe' }).flags).toBe('00');
    const fresh = serverTraceContext(null);
    expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.parentSpanId).toBeUndefined();
    expect(fresh.flags).toBe('01');
  });

  it('derives outgoing headers from the current context (child span) or a new trace', () => {
    expect(currentTraceContext()).toBeUndefined();
    const parent: TraceContext = { traceId, spanId: parentId, flags: '01' };
    const inside = runWithTraceContext(parent, () => outgoingTraceparent());
    const match = TRACEPARENT.exec(inside);
    expect(match?.[1]).toBe(traceId);
    expect(match?.[2]).not.toBe(parentId);
    expect(match?.[3]).toBe('01');
    const outside = TRACEPARENT.exec(outgoingTraceparent());
    expect(outside?.[1]).not.toBe(traceId);
    expect(formatTraceparent(traceId, parentId, '01')).toBe(`00-${traceId}-${parentId}-01`);
  });
});

// ── Application tests (database dfn_test_obs) ────────────────────────────────

describe('GET /metrics with METRICS_ENABLED=false', () => {
  it('is a plain 404 (the endpoint is not registered at all)', async () => {
    const disabled = await bootTestApp({ METRICS_ENABLED: 'false' });
    try {
      const res = await disabled.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    } finally {
      await disabled.close();
    }
  });
});

describe('GET /metrics without METRICS_TOKEN (loopback mode)', () => {
  it('serves a direct loopback peer and refuses the same peer behind a proxy (403)', async () => {
    // No token in the test environment: supertest connects over loopback.
    const tokenless = await bootTestApp({ METRICS_TOKEN: undefined });
    try {
      const direct = await tokenless.http().get('/metrics');
      expect(direct.status).toBe(200);
      expect(direct.text).toContain('# TYPE dfn_http_requests_total counter');
      // What the web app's same-origin /api rewrite looks like from the API on a shared host:
      // the Next.js proxy connects from 127.0.0.1 and adds X-Forwarded-Host.
      const viaWeb = await tokenless.http().get('/metrics').set('X-Forwarded-Host', 'localhost:3000');
      expect(viaWeb.status).toBe(403);
      expect(viaWeb.body.code).toBe('FORBIDDEN');
      expect(viaWeb.text).not.toContain('dfn_http_requests_total');
      for (const [name, value] of [
        ['X-Forwarded-For', '203.0.113.9'],
        ['Forwarded', 'for=203.0.113.9'],
        ['Via', '1.1 nginx'],
      ]) {
        expect((await tokenless.http().get('/metrics').set(name!, value!)).status, name).toBe(403);
      }
      // A bearer header is ignored in this mode: the direct loopback peer is served regardless.
      expect((await tokenless.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(
        200,
      );
    } finally {
      await tokenless.close();
    }
  });
});

describe('observability (metrics, gauges, traces)', () => {
  let ctx: TestContext;
  let server: Server;
  let port = 0;
  const received: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];

  const scrape = async () => {
    // The HTTP series are recorded on the response's `finish` event, right after the client got it.
    await new Promise((resolve) => setImmediate(resolve));
    const res = await ctx.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    return res.text as string;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({ path: req.url ?? '/', headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    ctx = await bootTestApp({ METRICS_TOKEN: TOKEN });
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
  });
  afterAll(async () => {
    // Managed keys seeded below would make the next boot with KMS_PROVIDER=none fail on purpose.
    await resetDatabase(ctx.prisma);
    await ctx.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('requires the bearer token (401 without or with a wrong one, 200 with it)', async () => {
    const missing = await ctx.http().get('/metrics');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer realm="metrics"');
    expect(missing.body.code).toBe('UNAUTHENTICATED');
    expect(missing.headers['x-dfn-mode']).toBe('sandbox');
    const wrong = await ctx
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN.slice(0, -1)}z`);
    expect(wrong.status).toBe(401);
    const ok = await ctx.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.headers['content-type']).toContain('version=0.0.4');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.text).toContain('# TYPE dfn_process_cpu_seconds_total counter');
    expect(ok.text).toContain('# TYPE dfn_nodejs_eventloop_lag_seconds gauge');
    expect(ok.text).toMatch(/^dfn_api_info\{instance_id="[^"]+",mode="sandbox",node_version="v[^"]+"\} 1$/m);
    expect(ok.text).toContain('# TYPE dfn_http_requests_total counter');
    expect(ok.text).toContain('# TYPE dfn_http_request_duration_seconds histogram');
    // The token never appears in the page.
    expect(ok.text).not.toContain(TOKEN);
  });

  it('labels HTTP series with route templates, never with identifiers or raw URLs', async () => {
    const id = randomUUID();
    expect((await ctx.http().get('/v1/health')).status).toBe(200);
    expect((await ctx.http().get(`/v1/transfers/${id}`)).status).toBe(401);
    expect((await ctx.http().get(`/no/such/route/${id}?q=1`)).status).toBe(404);
    expect((await ctx.http().post('/v1/auth/login').send({})).status).toBeGreaterThanOrEqual(400);
    // The bare root path (load-balancer / uptime probes) goes through the instrumentation too.
    const unmatchedBefore =
      sampleValue(await scrape(), 'dfn_http_requests_total', {
        method: 'GET',
        route: 'unmatched',
        status: '404',
      }) ?? 0;
    const root = await ctx.http().get('/');
    expect(root.status).toBe(404);
    expect(root.headers['traceparent']).toMatch(TRACEPARENT);
    const text = await scrape();
    expect(
      sampleValue(text, 'dfn_http_requests_total', { method: 'GET', route: 'unmatched', status: '404' }),
    ).toBe(unmatchedBefore + 1);
    expect(text).not.toContain(id);
    expect(text).not.toContain('q=1');
    expect(
      sampleValue(text, 'dfn_http_requests_total', { method: 'GET', route: '/v1/health', status: '200' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      sampleValue(text, 'dfn_http_requests_total', {
        method: 'GET',
        route: '/v1/transfers/:id',
        status: '401',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      sampleValue(text, 'dfn_http_requests_total', { method: 'GET', route: 'unmatched', status: '404' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      sampleValue(text, 'dfn_http_requests_total', { method: 'POST', route: '/v1/auth/login' }),
    ).toBeGreaterThanOrEqual(1);
    // Refused scrapes are counted under the endpoint's own label.
    expect(
      sampleValue(text, 'dfn_http_requests_total', { method: 'GET', route: '/metrics', status: '401' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      sampleValue(text, 'dfn_http_request_duration_seconds_count', { method: 'GET', route: '/v1/health' }),
    ).toBeGreaterThanOrEqual(1);
    const routes = new Set(
      parseSamples(text)
        .filter((s) => s.name === 'dfn_http_requests_total')
        .map((s) => s.labels.route),
    );
    for (const route of routes) expect(route, route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('echoes a continued or new traceparent on every response', async () => {
    const traceId = 'a'.repeat(32);
    const continued = await ctx
      .http()
      .get('/v1/health')
      .set('traceparent', `00-${traceId}-${'b'.repeat(16)}-01`);
    const echoed = TRACEPARENT.exec(continued.headers['traceparent'] as string);
    expect(echoed?.[1]).toBe(traceId);
    expect(echoed?.[2]).not.toBe('b'.repeat(16));
    expect(echoed?.[3]).toBe('01');
    const invalid = await ctx
      .http()
      .get('/v1/health')
      .set('traceparent', `00-${traceId.toUpperCase()}-${'b'.repeat(16)}-01`);
    const replaced = TRACEPARENT.exec(invalid.headers['traceparent'] as string);
    expect(replaced?.[1]).not.toBe(traceId);
    const fresh = await ctx.http().get('/nowhere');
    expect(fresh.status).toBe(404);
    expect(fresh.headers['traceparent']).toMatch(TRACEPARENT);
    const scraped = await ctx.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(scraped.headers['traceparent']).toMatch(TRACEPARENT);
  });

  it('propagates the trace to outgoing webhook requests as a child span', async () => {
    received.length = 0;
    const parent: TraceContext = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), flags: '01' };
    await runWithTraceContext(parent, () =>
      postWebhook(`http://127.0.0.1:${port}/direct`, { 'X-Test': '1' }, '{}', 2_000, false),
    );
    const direct = TRACEPARENT.exec(received[0]!.headers['traceparent'] as string);
    expect(direct?.[1]).toBe(parent.traceId);
    expect(direct?.[2]).not.toBe(parent.spanId);
    expect(received[0]!.headers['x-test']).toBe('1');
    // Outside any request (scheduler retries): a new trace.
    await postWebhook(`http://127.0.0.1:${port}/scheduled`, {}, '{}', 2_000, false);
    const scheduled = TRACEPARENT.exec(received[1]!.headers['traceparent'] as string);
    expect(scheduled?.[1]).not.toBe(parent.traceId);
    // A caller-provided header wins.
    await postWebhook(
      `http://127.0.0.1:${port}/explicit`,
      { traceparent: `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01` },
      '{}',
      2_000,
      false,
    );
    expect(received[2]!.headers['traceparent']).toBe(`00-${'e'.repeat(32)}-${'f'.repeat(16)}-01`);

    // Through the dispatcher (the path a domain event takes inside a request).
    const { client } = await registerUser(ctx, 'obs-webhooks@example.com');
    const created = await client.post('/v1/webhooks', {
      url: `http://127.0.0.1:${port}/hook`,
      events: ['transaction.created'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const eventId = randomUUID();
    const delivery = await ctx.prisma.webhookDelivery.create({
      data: {
        subscriptionId: created.body.webhook.id,
        eventType: 'transaction.created',
        eventId,
        payload: {
          id: eventId,
          type: 'transaction.created',
          createdAt: new Date().toISOString(),
          sandbox: true,
          data: {},
        },
        signature: 'test',
      },
    });
    received.length = 0;
    const dispatcher = ctx.app.get(WebhookDispatcherService);
    // 'event' is the source a domain event uses for a fresh PENDING row inside a request.
    await runWithTraceContext(parent, () => dispatcher.deliver(delivery.id, 'event'));
    expect(received).toHaveLength(1);
    const hook = TRACEPARENT.exec(received[0]!.headers['traceparent'] as string);
    expect(hook?.[1]).toBe(parent.traceId);
    expect(hook?.[2]).not.toBe(parent.spanId);
    expect(received[0]!.headers['x-dfn-delivery']).toBe(delivery.id);
    expect((await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe(
      'DELIVERED',
    );

    // Through a real HTTP request: the context the instrumentation middleware creates must survive
    // Nest guards, pipes and the handler into postWebhook (POST /v1/webhooks/:id/test delivers
    // synchronously). The session cookie is taken from a login so that a custom header can be sent.
    const login = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: 'obs-webhooks@example.com', password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .join('; ');
    const incomingTraceId = '1'.repeat(32);
    const incomingParent = '2'.repeat(16);
    received.length = 0;
    const tested = await ctx
      .http()
      .post(`/v1/webhooks/${created.body.webhook.id}/test`)
      .set('Cookie', cookie)
      .set('traceparent', `00-${incomingTraceId}-${incomingParent}-01`)
      .send({ eventType: 'transaction.created' });
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body.status).toBe('DELIVERED');
    const response = TRACEPARENT.exec(tested.headers['traceparent'] as string);
    expect(response?.[1]).toBe(incomingTraceId);
    expect(received).toHaveLength(1);
    const viaHttp = TRACEPARENT.exec(received[0]!.headers['traceparent'] as string);
    // Same trace as the incoming header; a span of its own, distinct from the request's span and
    // from the caller's parent.
    expect(viaHttp?.[1]).toBe(incomingTraceId);
    expect(viaHttp?.[2]).not.toBe(response?.[2]);
    expect(viaHttp?.[2]).not.toBe(incomingParent);
    expect(viaHttp?.[3]).toBe('01');
    expect(received[0]!.headers['x-dfn-delivery']).toBe(tested.body.id);
  });

  it('exposes the registered jobs and an explicit "never ran" state, so stale rules can fire on a fresh database', async () => {
    // No MaintenanceRun nor ReconciliationJob row exists yet (resetDatabase in beforeAll): this is
    // the state of a deployment whose scheduler never ticked.
    expect(await ctx.prisma.maintenanceRun.count()).toBe(0);
    expect(await ctx.prisma.reconciliationJob.count()).toBe(0);
    const gauges = ctx.app.get(DomainGaugesService);
    gauges.invalidate();
    const text = await scrape();
    const registered = ctx.app.get(JobRegistry).list();
    expect(registered).toEqual(expect.arrayContaining(['RECONCILIATION', 'WEBHOOK_RETRY', 'KEY_LIFECYCLE']));
    for (const jobName of registered) {
      // Left side of DfnMaintenanceJobNeverSucceeded (`registered unless on (job_name) last_success_age`)…
      expect(sampleValue(text, 'dfn_maintenance_job_registered', { job_name: jobName }), jobName).toBe(1);
      // …and its right side, absent: the rule's vector is every registered job.
      expect(
        sampleValue(text, 'dfn_maintenance_job_last_success_age_seconds', { job_name: jobName }),
      ).toBeUndefined();
      expect(sampleValue(text, 'dfn_maintenance_job_last_run_status', { job_name: jobName })).toBeUndefined();
    }
    // DfnReconciliationNeverRun: the status series exist and sum to 0 (no series at all would mean
    // a failed collector, which is DfnMetricsCollectErrors' job).
    const statuses = parseSamples(text).filter((s) => s.name === 'dfn_ledger_reconciliation_last_run_status');
    expect(statuses.map((s) => s.labels.status).sort()).toEqual(['COMPLETED', 'FAILED', 'RUNNING']);
    expect(statuses.reduce((sum, s) => sum + s.value, 0)).toBe(0);
    expect(sampleValue(text, 'dfn_ledger_reconciliation_last_run_age_seconds')).toBeUndefined();
    expect(sampleValue(text, 'dfn_ledger_reconciliation_last_completed_differences')).toBeUndefined();
    expect(parseSamples(text).some((s) => s.name === 'dfn_metrics_collect_errors_total')).toBe(false);
  });

  it('computes the domain gauges from the database (cached, refreshed on demand)', async () => {
    const now = Date.now();
    const minutes = (n: number) => new Date(now - n * 60_000);
    const { user } = await registerUser(ctx, 'obs-owner@example.com');
    const org = await ctx.prisma.organization.create({
      data: { name: 'Obs Org', type: 'BUSINESS', country: 'CA' },
    });
    const { client } = await registerUser(ctx, 'obs-subscriber@example.com');
    const sub = await client.post('/v1/webhooks', {
      url: `http://127.0.0.1:${port}/hook`,
      events: ['transaction.created'],
    });
    expect(sub.status).toBe(201);
    const deliveryData = (
      status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'EXHAUSTED',
      nextAttemptAt: Date | null,
    ) => {
      const eventId = randomUUID();
      return {
        subscriptionId: sub.body.webhook.id as string,
        eventType: 'transaction.created',
        eventId,
        payload: {
          id: eventId,
          type: 'transaction.created',
          createdAt: new Date().toISOString(),
          sandbox: true,
          data: {},
        },
        signature: 'test',
        status,
        attempts: status === 'PENDING' ? 0 : 3,
        nextAttemptAt,
      };
    };
    await Promise.all([
      ctx.prisma.maintenanceRun.createMany({
        data: [
          {
            jobName: 'BALANCE_SNAPSHOTS',
            status: 'COMPLETED',
            startedAt: minutes(10),
            finishedAt: minutes(9),
          },
          { jobName: 'RECONCILIATION', status: 'COMPLETED', startedAt: minutes(60), finishedAt: minutes(59) },
          {
            jobName: 'RECONCILIATION',
            status: 'FAILED',
            startedAt: minutes(5),
            finishedAt: minutes(4),
            error: 'boom',
          },
          { jobName: 'AUTH_CLEANUP', status: 'RUNNING', startedAt: minutes(3) },
        ],
      }),
      ctx.prisma.webhookDelivery.createMany({
        data: [
          deliveryData('FAILED', minutes(120)),
          deliveryData('FAILED', minutes(-60)),
          deliveryData('EXHAUSTED', null),
          deliveryData('DELIVERED', null),
        ],
      }),
      ctx.prisma.riskAlert.createMany({
        data: [
          {
            ruleCode: 'OBS_TEST',
            severity: 'HIGH',
            score: 90,
            explanation: {},
            status: 'OPEN',
            dueAt: minutes(30),
            slaBreachedAt: minutes(20),
          },
          {
            ruleCode: 'OBS_TEST',
            severity: 'HIGH',
            score: 80,
            explanation: {},
            status: 'REVIEWING',
            dueAt: minutes(10),
          },
          {
            ruleCode: 'OBS_TEST',
            severity: 'MEDIUM',
            score: 50,
            explanation: {},
            status: 'OPEN',
            dueAt: minutes(-600),
          },
          {
            ruleCode: 'OBS_TEST',
            severity: 'LOW',
            score: 10,
            explanation: {},
            status: 'DISMISSED',
            dueAt: minutes(600),
            slaBreachedAt: minutes(500),
          },
        ],
      }),
      ctx.prisma.counterparty.createMany({
        data: [
          { organizationId: org.id, name: 'Pending', linkStatus: 'PENDING', linkRequestedAt: minutes(1) },
          { organizationId: org.id, name: 'Accepted', linkStatus: 'ACCEPTED' },
        ],
      }),
      ctx.prisma.transfer.createMany({
        data: ['REVIEW_REQUIRED', 'REVIEW_REQUIRED', 'SETTLED'].map((status, i) => ({
          reference: `OBS-${i}`,
          organizationId: org.id,
          createdByUserId: user.id,
          originCountry: 'CA',
          destinationCountry: 'SN',
          sourceCurrency: 'CAD',
          destinationCurrency: 'XOF',
          sourceAmountMinor: 10_000n,
          status: status as 'REVIEW_REQUIRED' | 'SETTLED',
          beneficiary: { name: 'Fictitious beneficiary' },
        })),
      }),
      ctx.prisma.document.createMany({
        data: (['INFECTED', 'CLEAN', 'CLEAN'] as const).map((scanStatus) => ({
          organizationId: org.id,
          uploadedByUserId: user.id,
          title: 'obs',
          fileName: 'obs.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          sha256: 'a'.repeat(64),
          storageKey: randomUUID(),
          scanStatus,
        })),
      }),
      ctx.prisma.encryptionKey.createMany({
        data: [
          {
            purpose: 'documents',
            keyId: 'obs-1',
            status: 'ACTIVE',
            wrappedKey: Buffer.alloc(32, 1),
            kmsProvider: 'local',
            kmsKeyRef: 'test',
          },
          {
            purpose: 'documents',
            keyId: 'obs-2',
            status: 'STAGED',
            wrappedKey: Buffer.alloc(32, 2),
            kmsProvider: 'local',
            kmsKeyRef: 'test',
          },
        ],
      }),
      ctx.prisma.reconciliationJob.createMany({
        data: [
          {
            status: 'COMPLETED',
            startedAt: minutes(40),
            finishedAt: minutes(39),
            accountsChecked: 10,
            differencesFound: 2,
          },
          {
            status: 'FAILED',
            startedAt: minutes(8),
            finishedAt: minutes(7),
            accountsChecked: 0,
            differencesFound: 0,
          },
        ],
      }),
    ]);

    const gauges = ctx.app.get(DomainGaugesService);
    gauges.invalidate();
    const text = await scrape();
    const v = (name: string, labels: Record<string, string> = {}) => sampleValue(text, name, labels);

    expect(
      v('dfn_maintenance_job_last_run_status', { job_name: 'BALANCE_SNAPSHOTS', status: 'COMPLETED' }),
    ).toBe(1);
    expect(
      v('dfn_maintenance_job_last_run_status', { job_name: 'BALANCE_SNAPSHOTS', status: 'FAILED' }),
    ).toBe(0);
    expect(v('dfn_maintenance_job_last_run_status', { job_name: 'RECONCILIATION', status: 'FAILED' })).toBe(
      1,
    );
    expect(v('dfn_maintenance_job_last_run_status', { job_name: 'AUTH_CLEANUP', status: 'RUNNING' })).toBe(1);
    expect(
      v('dfn_maintenance_job_last_run_age_seconds', { job_name: 'RECONCILIATION' }),
    ).toBeGreaterThanOrEqual(5 * 60 - 5);
    expect(v('dfn_maintenance_job_last_run_duration_seconds', { job_name: 'BALANCE_SNAPSHOTS' })).toBeCloseTo(
      60,
      0,
    );
    expect(
      v('dfn_maintenance_job_last_run_duration_seconds', { job_name: 'AUTH_CLEANUP' }),
    ).toBeGreaterThanOrEqual(3 * 60 - 5);
    expect(
      v('dfn_maintenance_job_last_success_age_seconds', { job_name: 'RECONCILIATION' }),
    ).toBeGreaterThanOrEqual(59 * 60 - 5);
    expect(v('dfn_maintenance_job_last_success_age_seconds', { job_name: 'AUTH_CLEANUP' })).toBeUndefined();
    expect(v('dfn_maintenance_job_last_run_status', { job_name: 'KEY_LIFECYCLE' })).toBeUndefined();

    expect(v('dfn_webhook_deliveries', { status: 'FAILED' })).toBe(2);
    expect(v('dfn_webhook_deliveries', { status: 'EXHAUSTED' })).toBe(1);
    expect(v('dfn_webhook_deliveries', { status: 'DELIVERED' })).toBe(
      await ctx.prisma.webhookDelivery.count({ where: { status: 'DELIVERED' } }),
    );
    expect(v('dfn_webhook_deliveries', { status: 'PENDING' })).toBe(0);
    expect(v('dfn_webhook_deliveries_due')).toBe(1);
    expect(v('dfn_webhook_oldest_due_age_seconds')).toBeGreaterThanOrEqual(120 * 60 - 5);

    expect(v('dfn_review_alerts_open', { severity: 'HIGH' })).toBe(2);
    expect(v('dfn_review_alerts_open', { severity: 'MEDIUM' })).toBe(1);
    expect(v('dfn_review_alerts_open', { severity: 'LOW' })).toBe(0);
    expect(v('dfn_review_alerts_sla_breached', { severity: 'HIGH' })).toBe(1);
    expect(v('dfn_review_alerts_sla_breached', { severity: 'LOW' })).toBe(0);
    expect(v('dfn_review_alerts_overdue', { severity: 'HIGH' })).toBe(2);
    expect(v('dfn_review_alerts_overdue', { severity: 'MEDIUM' })).toBe(0);

    expect(v('dfn_counterparty_link_requests_pending')).toBe(1);
    expect(v('dfn_transfers', { status: 'REVIEW_REQUIRED' })).toBe(2);
    expect(v('dfn_transfers', { status: 'SETTLED' })).toBe(1);
    expect(v('dfn_transfers', { status: 'CREATED' })).toBe(0);
    expect(v('dfn_documents', { scan_status: 'INFECTED' })).toBe(1);
    expect(v('dfn_documents', { scan_status: 'CLEAN' })).toBe(2);
    expect(v('dfn_documents', { scan_status: 'NOT_SCANNED' })).toBe(0);
    expect(v('dfn_encryption_keys', { purpose: 'documents', status: 'ACTIVE' })).toBe(1);
    expect(v('dfn_encryption_keys', { purpose: 'documents', status: 'STAGED' })).toBe(1);
    expect(v('dfn_encryption_keys', { purpose: 'documents', status: 'RETIRED' })).toBe(0);
    expect(v('dfn_encryption_keys', { purpose: 'webhooks', status: 'ACTIVE' })).toBe(0);
    expect(v('dfn_ledger_reconciliation_last_run_status', { status: 'FAILED' })).toBe(1);
    expect(v('dfn_ledger_reconciliation_last_run_status', { status: 'COMPLETED' })).toBe(0);
    expect(v('dfn_ledger_reconciliation_last_run_age_seconds')).toBeGreaterThanOrEqual(8 * 60 - 5);
    expect(v('dfn_ledger_reconciliation_last_completed_differences')).toBe(2);
    expect(v('dfn_ledger_reconciliation_last_completed_accounts_checked')).toBe(10);
    expect(v('dfn_metrics_snapshot_age_seconds')).toBeLessThan(5);
    expect(v('dfn_metrics_collect_duration_seconds')).toBeGreaterThan(0);
    expect(parseSamples(text).some((s) => s.name === 'dfn_metrics_collect_errors_total')).toBe(false);

    // Within the cache window a scrape does not re-read the database.
    await ctx.prisma.counterparty.updateMany({
      where: { linkStatus: 'PENDING' },
      data: { linkStatus: 'DECLINED' },
    });
    expect(sampleValue(await scrape(), 'dfn_counterparty_link_requests_pending')).toBe(1);
    gauges.invalidate();
    expect(sampleValue(await scrape(), 'dfn_counterparty_link_requests_pending')).toBe(0);
  });

  const COLLECTORS = [
    'maintenance_runs',
    'webhook_deliveries',
    'review_queue',
    'link_requests',
    'transfers',
    'documents',
    'encryption_keys',
    'ledger_reconciliation',
  ];

  /**
   * A Prisma stand-in: `$transaction` hands the callback a client whose queries behave as `query`
   * says (the statement_timeout set_config of withStatementTimeout always succeeds). Counts the
   * transactions opened and how many are open at once.
   */
  function fakeDatabase(query: () => Promise<never>) {
    const stats = { transactions: 0, open: 0, maxOpen: 0, timeouts: [] as string[] };
    const tx = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings[0]!.includes('set_config')) {
          stats.timeouts.push(String(values[0]));
          return Promise.resolve([]);
        }
        return query();
      },
      webhookDelivery: { groupBy: query },
      counterparty: { count: query },
      transfer: { groupBy: query },
      document: { groupBy: query },
      encryptionKey: { groupBy: query },
      reconciliationJob: { findFirst: query },
    };
    const db = {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
        stats.transactions += 1;
        stats.open += 1;
        stats.maxOpen = Math.max(stats.maxOpen, stats.open);
        try {
          return await fn(tx);
        } finally {
          stats.open -= 1;
        }
      },
    } as unknown as PrismaService;
    return { db, stats };
  }
  const registryOf = (...names: string[]) => ({ list: () => names }) as unknown as JobRegistry;

  it('keeps serving /metrics when every collector fails, counting the errors', async () => {
    const env = ctx.app.get<Env>(ENV);
    const metrics = new MetricsService(env);
    const { db, stats } = fakeDatabase(() => Promise.reject(new Error('database unavailable')));
    const gauges = new DomainGaugesService(db, metrics, registryOf('RECONCILIATION'), {
      ttlMs: 0,
      timeoutMs: 100,
    });
    const text = await metrics.render();
    expect(text).toContain('# TYPE dfn_http_requests_total counter');
    expect(text).toContain('# TYPE dfn_process_cpu_seconds_total counter');
    for (const collector of COLLECTORS) {
      expect(sampleValue(text, 'dfn_metrics_collect_errors_total', { collector }), collector).toBe(1);
    }
    // No stale or partial value is served for a failed collector.
    expect(parseSamples(text).some((s) => s.name === 'dfn_transfers')).toBe(false);
    expect(parseSamples(text).some((s) => s.name === 'dfn_counterparty_link_requests_pending')).toBe(false);
    expect(parseSamples(text).some((s) => s.name === 'dfn_maintenance_job_registered')).toBe(false);
    // Every collector ran in its own transaction, one at a time, with a statement_timeout set.
    expect(stats.transactions).toBe(COLLECTORS.length);
    expect(stats.maxOpen).toBe(1);
    expect(stats.timeouts).toHaveLength(COLLECTORS.length);
    for (const ms of stats.timeouts) expect(Number(ms)).toBeGreaterThan(0);
    // A second scrape (ttl 0) counts again, and the errors accumulate.
    gauges.invalidate();
    expect(
      sampleValue(await metrics.render(), 'dfn_metrics_collect_errors_total', { collector: 'link_requests' }),
    ).toBe(2);
  });

  it('runs collectors one at a time within the deadline and never re-enters one whose query hangs', async () => {
    const env = ctx.app.get<Env>(ENV);
    const metrics = new MetricsService(env);
    const { db, stats } = fakeDatabase(() => new Promise<never>(() => undefined));
    const gauges = new DomainGaugesService(db, metrics, registryOf(), { ttlMs: 0, timeoutMs: 150 });
    // First refresh: the first collector hangs until the deadline; the budget is spent, the others
    // are skipped — one transaction, not eight parallel ones.
    const first = await metrics.render();
    expect(stats.transactions).toBe(1);
    expect(stats.open).toBe(1);
    for (const collector of COLLECTORS) {
      expect(sampleValue(first, 'dfn_metrics_collect_errors_total', { collector }), collector).toBe(1);
    }
    expect(sampleValue(first, 'dfn_metrics_collect_duration_seconds')).toBeLessThan(1);
    // Second refresh: the hung collector is still pending and is not started again (single-flight);
    // the next one gets the budget. Pending queries grow by at most one per refresh and are bounded
    // by the number of collectors, instead of piling up on every scrape.
    gauges.invalidate();
    const second = await metrics.render();
    expect(stats.transactions).toBe(2);
    expect(stats.open).toBe(2);
    expect(stats.maxOpen).toBe(2);
    for (const collector of COLLECTORS) {
      expect(sampleValue(second, 'dfn_metrics_collect_errors_total', { collector }), collector).toBe(2);
    }
    gauges.invalidate();
    await metrics.render();
    expect(stats.transactions).toBe(3);
  });

  it('cancels a collector query on the server at the deadline (statement_timeout), releasing its connection', async () => {
    const startedAt = Date.now();
    await expect(
      withStatementTimeout(ctx.prisma, 200, async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(5)`;
        return 'not reached';
      }),
    ).rejects.toThrow(/statement timeout/i);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The setting was local to that transaction: the pooled connection is back to the default.
    const [row] = await ctx.prisma.$queryRaw<
      Array<{ value: string }>
    >`SELECT current_setting('statement_timeout') AS value`;
    expect(row?.value).toBe('0');
    // A query within budget resolves normally.
    expect(
      await withStatementTimeout(ctx.prisma, 2_000, async (tx) => (await tx.counterparty.count()) >= 0),
    ).toBe(true);
  });

  it('alert rules only reference metrics the API exposes and sections of the observability runbook', async () => {
    const text = await scrape();
    const exposed = exposedNames(text);
    const rules = parseYamlSubset(repoFile('../../../infra/observability/prometheus/alerts.yml')) as {
      groups: Array<{ name: string; rules: Array<{ [key: string]: YamlValue }> }>;
    };
    const anchors = new Set(
      [...repoFile('../../../docs/operations/OBSERVABILITY.md').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
        headingAnchor(m[1]!),
      ),
    );
    expect(rules.groups.length).toBeGreaterThanOrEqual(5);
    const names = new Set<string>();
    for (const group of rules.groups) {
      expect(group.name).toMatch(/^dfn-/);
      expect(Array.isArray(group.rules) && group.rules.length > 0, group.name).toBe(true);
      for (const rule of group.rules) {
        const alert = rule.alert as string;
        expect(alert, group.name).toMatch(/^Dfn[A-Z][A-Za-z0-9]+$/);
        expect(names.has(alert), `duplicate alert ${alert}`).toBe(false);
        names.add(alert);
        const expr = rule.expr as string;
        expect(typeof expr === 'string' && expr.trim().length > 0, alert).toBe(true);
        for (const metric of new Set(expr.match(/\bdfn_[a-z0-9_]+\b/g) ?? [])) {
          expect(exposed.has(metric), `${alert}: ${metric} is not exposed by /metrics`).toBe(true);
        }
        // Either a dfn_* metric or Prometheus' own `up` must be involved.
        expect(/\bdfn_[a-z0-9_]+\b/.test(expr) || /\bup\{/.test(expr), alert).toBe(true);
        if (rule.for !== undefined) expect(rule.for, alert).toMatch(/^\d+[smhd]$/);
        const labels = rule.labels as { [key: string]: YamlValue };
        expect(['critical', 'warning'], alert).toContain(labels.severity);
        expect(labels.service, alert).toBe('dfn-api');
        const annotations = rule.annotations as { [key: string]: YamlValue };
        for (const key of ['summary', 'description', 'runbook_url']) {
          expect(
            typeof annotations[key] === 'string' && (annotations[key] as string).length > 0,
            `${alert}.${key}`,
          ).toBe(true);
        }
        const runbook = annotations.runbook_url as string;
        const [file, anchor] = runbook.split('#');
        expect(file, alert).toBe('docs/operations/OBSERVABILITY.md');
        expect(anchors.has(anchor ?? ''), `${alert}: no heading for #${anchor} in OBSERVABILITY.md`).toBe(
          true,
        );
        expect(anchor, alert).toBe(alert.toLowerCase());
      }
    }
    for (const required of [
      'DfnApiDown',
      'DfnApiAbsent',
      'DfnApiHigh5xxRatio',
      'DfnApiHighLatencyP95',
      'DfnMaintenanceJobFailed',
      'DfnMaintenanceJobStale',
      'DfnMaintenanceJobNeverSucceeded',
      'DfnReconciliationNeverRun',
      'DfnWebhookBacklog',
      'DfnWebhookExhausted',
      'DfnReviewSlaBreached',
      'DfnDocumentInfected',
      'DfnDocumentScanUnavailable',
      'DfnDocumentScanSizeLimit',
      'DfnReconciliationDifferences',
      'DfnMetricsCollectErrors',
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });
});
