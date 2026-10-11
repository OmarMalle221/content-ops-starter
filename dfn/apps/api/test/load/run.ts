/**
 * Load test of the DFN API — SANDBOX ONLY (fictitious data, no real funds).
 *
 * Uses autocannon v8 programmatically against a RUNNING API (it never boots one):
 *   1. checks the target answers `x-dfn-mode: sandbox` on /v1/health (refuses otherwise);
 *   2. signs in a seeded user (moussa@demo.dfn by default) or registers a fresh one;
 *   3. measures, one scenario after the other, N connections for D seconds each:
 *        health · wallet summary · transactions list · FX estimate · transfers list
 *      (+ a ledger write scenario, opt-in with LOAD_WRITES=1, on a single connection);
 *   4. prints p50 / p95 / p99 latency, throughput and errors as a Markdown table and exits non-zero
 *      when a p95 exceeds its target (PRODUCT_REQUIREMENTS.md §5) or when errors exceed 1 %.
 *
 * Targets (PRODUCT_REQUIREMENTS.md §5 « Performance »):
 *   - paginated lists (≤ 100 per page) < 500 ms p95 — applied to every read scenario;
 *   - ledger write < 100 ms p95 outside contention — the opt-in write scenario (one connection).
 *
 * Environment:
 *   BASE_URL            API base URL (default http://localhost:4100). Only loopback hosts are
 *                       accepted unless LOAD_ALLOW_REMOTE=1 (never point it at someone else's server).
 *   LOAD_EMAIL / LOAD_PASSWORD   account to sign in with (default: seeded demo buyer). When sign-in
 *                       fails, a fresh account load-<timestamp>@example.com is registered.
 *   LOAD_CONNECTIONS    concurrent connections per read scenario (default 10)
 *   LOAD_DURATION       measured seconds per scenario (default 10)
 *   LOAD_WARMUP         unmeasured warm-up seconds per scenario (default 2, 0 to disable)
 *   LOAD_CLIENT_MODE    "distinct" (default): every request carries its own X-Forwarded-For, i.e. the
 *                       load behaves like many clients behind the trusted reverse proxy, each within
 *                       the per-IP throttle (120 req/min); "single": one client, so the throttle
 *                       answers 429 after 120 requests per route and minute (measures the throttle).
 *   LOAD_WRITES         "1" adds the ledger write scenario (sandbox self-deposits of 0.01 CAD)
 *   LOAD_ONLY           comma-separated scenario names to run (default: all)
 *   LOAD_JSON           optional path where the raw results are written as JSON
 *
 *   BASE_URL=http://localhost:4100 pnpm --filter @dfn/api test:load
 */
import autocannon from 'autocannon';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:4100').replace(/\/+$/, '');
const CONNECTIONS = intEnv('LOAD_CONNECTIONS', 10, 1, 1000);
const DURATION = intEnv('LOAD_DURATION', 10, 1, 3600);
const WARMUP = intEnv('LOAD_WARMUP', 2, 0, 600);
const CLIENT_MODE = process.env.LOAD_CLIENT_MODE === 'single' ? 'single' : 'distinct';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Sandbox-2026!Protect';
const READ_TARGET_P95_MS = 500;
const WRITE_TARGET_P95_MS = 100;
const MAX_ERROR_RATE = 0.01;

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

interface Scenario {
  name: string;
  label: string;
  method: 'GET' | 'POST';
  path: string;
  body?: () => string;
  connections: number;
  targetP95Ms: number;
  targetSource: string;
}

export interface ScenarioResult {
  name: string;
  label: string;
  connections: number;
  durationS: number;
  requests: number;
  throughputRps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  non2xx: Record<string, number>;
  socketErrors: number;
  timeouts: number;
  errorRate: number;
  targetP95Ms: number;
  targetSource: string;
  pass: boolean;
}

function assertTargetAllowed(url: string) {
  const { hostname, protocol } = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  if (!/^https?:$/.test(protocol)) throw new Error(`Unsupported protocol in BASE_URL: ${protocol}`);
  if (!loopback && process.env.LOAD_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to load-test ${hostname}: only loopback targets are allowed (set LOAD_ALLOW_REMOTE=1 for a sandbox you operate).`,
    );
  }
}

/** Sequential pseudo client addresses (10.x.y.z) — deterministic, no Math.random. */
let ipCounter = 0;
function nextClientIp(): string {
  ipCounter = (ipCounter + 1) % 16_000_000;
  const n = ipCounter + 1;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

async function signIn(): Promise<{ cookie: string; organizationId: string; email: string }> {
  const email = process.env.LOAD_EMAIL ?? 'moussa@demo.dfn';
  const password = process.env.LOAD_PASSWORD ?? DEMO_PASSWORD;
  const json = { 'content-type': 'application/json', 'x-forwarded-for': nextClientIp() };
  let res = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email, password }),
  });
  let usedEmail = email;
  if (res.status !== 200) {
    usedEmail = `load-${Date.now().toString(36)}@example.com`;
    console.log(`Sign-in as ${email} failed (${res.status}); registering ${usedEmail} instead.`);
    res = await fetch(`${BASE_URL}/v1/auth/register`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        email: usedEmail,
        password: 'CorrectHorse42Battery',
        firstName: 'Charge',
        lastName: 'Sandbox',
        country: 'CA',
        locale: 'fr',
        acceptTerms: true,
      }),
    });
    if (res.status !== 201) throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { mfaRequired?: boolean };
  if (body.mfaRequired)
    throw new Error(`${usedEmail} has MFA enabled: use an account without MFA for the load test`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('No session cookie returned by the API');
  const me = await fetch(`${BASE_URL}/v1/auth/me`, {
    headers: { cookie, 'x-forwarded-for': nextClientIp() },
  });
  const meBody = (await me.json()) as { user?: { organizations?: Array<{ id: string }> } };
  const organizationId = meBody.user?.organizations?.[0]?.id;
  if (!organizationId) throw new Error(`Could not resolve the organisation of ${usedEmail}`);
  return { cookie, organizationId, email: usedEmail };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

const round = (n: number) => Math.round(n * 10) / 10;

function runOnce(scenario: Scenario, cookie: string, seconds: number) {
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const baseHeaders: Record<string, string> = { cookie };
  if (scenario.body) baseHeaders['content-type'] = 'application/json';
  return new Promise<{
    latencies: number[];
    statusCounts: Record<string, number>;
    result: autocannon.Result;
  }>((resolve, reject) => {
    const instance = autocannon(
      {
        url: BASE_URL,
        connections: scenario.connections,
        duration: seconds,
        timeout: 30,
        requests: [
          {
            method: scenario.method,
            path: scenario.path,
            setupRequest: (req) => ({
              ...req,
              headers: {
                ...baseHeaders,
                ...(CLIENT_MODE === 'distinct' ? { 'x-forwarded-for': nextClientIp() } : {}),
              },
              ...(scenario.body ? { body: scenario.body() } : {}),
            }),
          },
        ],
      },
      (err, result) => (err ? reject(err) : resolve({ latencies, statusCounts, result })),
    );
    instance.on('response', (_client, statusCode, _bytes, responseTime) => {
      latencies.push(responseTime);
      statusCounts[String(statusCode)] = (statusCounts[String(statusCode)] ?? 0) + 1;
    });
  });
}

async function measure(scenario: Scenario, cookie: string): Promise<ScenarioResult> {
  if (WARMUP > 0) await runOnce(scenario, cookie, WARMUP);
  const { latencies, statusCounts, result } = await runOnce(scenario, cookie, DURATION);
  const sorted = [...latencies].sort((a, b) => a - b);
  const responses = latencies.length;
  const non2xx = Object.fromEntries(Object.entries(statusCounts).filter(([code]) => !code.startsWith('2')));
  const non2xxCount = Object.values(non2xx).reduce((a, b) => a + b, 0);
  const socketErrors = result.errors - result.timeouts;
  const failures = non2xxCount + result.errors;
  const attempts = responses + result.errors;
  const errorRate = attempts ? failures / attempts : 1;
  const p95 = round(percentile(sorted, 95));
  return {
    name: scenario.name,
    label: scenario.label,
    connections: scenario.connections,
    durationS: DURATION,
    requests: responses,
    throughputRps: round(responses / DURATION),
    p50: round(percentile(sorted, 50)),
    p95,
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(responses ? latencies.reduce((a, b) => a + b, 0) / responses : 0),
    non2xx,
    socketErrors,
    timeouts: result.timeouts,
    errorRate,
    targetP95Ms: scenario.targetP95Ms,
    targetSource: scenario.targetSource,
    pass: responses > 0 && p95 <= scenario.targetP95Ms && errorRate <= MAX_ERROR_RATE,
  };
}

function markdown(results: ScenarioResult[]): string {
  const header =
    '| Scénario | Requête | Conn. | Requêtes | Débit (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Erreurs | Objectif p95 | Verdict |';
  const sep = '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |';
  const rows = results.map((r) => {
    const errors =
      `${(r.errorRate * 100).toFixed(2)} %` +
      (Object.keys(r.non2xx).length || r.socketErrors || r.timeouts
        ? ` (${[
            ...Object.entries(r.non2xx).map(([code, n]) => `${code}×${n}`),
            ...(r.socketErrors ? [`socket×${r.socketErrors}`] : []),
            ...(r.timeouts ? [`timeout×${r.timeouts}`] : []),
          ].join(', ')})`
        : '');
    return `| ${r.name} | \`${r.label}\` | ${r.connections} | ${r.requests} | ${r.throughputRps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${errors} | < ${r.targetP95Ms} ms | ${r.pass ? 'OK' : 'ÉCHEC'} |`;
  });
  return [header, sep, ...rows].join('\n');
}

async function main() {
  assertTargetAllowed(BASE_URL);
  // The preflight is not measured: it always presents its own client address so that a previous
  // "single" run (throttled for a minute) cannot hide the sandbox header behind a 429.
  const health = await fetch(`${BASE_URL}/v1/health`, { headers: { 'x-forwarded-for': nextClientIp() } });
  if (health.status === 429) {
    throw new Error(`${BASE_URL} is throttling this client (429) — retry in a minute`);
  }
  if (health.headers.get('x-dfn-mode') !== 'sandbox') {
    throw new Error(`${BASE_URL} does not answer x-dfn-mode: sandbox — refusing to run`);
  }
  const { cookie, organizationId, email } = await signIn();
  const countHeaders = { cookie, 'x-forwarded-for': nextClientIp() };
  const dataset = {
    transactions: (
      (await (await fetch(`${BASE_URL}/v1/transactions?pageSize=1`, { headers: countHeaders })).json()) as {
        total?: number;
      }
    ).total,
    transfers: (
      (await (await fetch(`${BASE_URL}/v1/transfers?pageSize=1`, { headers: countHeaders })).json()) as {
        total?: number;
      }
    ).total,
  };

  const readTarget = 'PRD §5 : liste paginée < 500 ms p95';
  const scenarios: Scenario[] = [
    {
      name: 'health',
      label: 'GET /v1/health',
      method: 'GET',
      path: '/v1/health',
      connections: CONNECTIONS,
      targetP95Ms: READ_TARGET_P95_MS,
      targetSource: readTarget,
    },
    {
      name: 'wallet-summary',
      label: 'GET /v1/wallets/:org/summary',
      method: 'GET',
      path: `/v1/wallets/${organizationId}/summary`,
      connections: CONNECTIONS,
      targetP95Ms: READ_TARGET_P95_MS,
      targetSource: readTarget,
    },
    {
      name: 'transactions',
      label: 'GET /v1/transactions?pageSize=20',
      method: 'GET',
      path: '/v1/transactions?page=1&pageSize=20',
      connections: CONNECTIONS,
      targetP95Ms: READ_TARGET_P95_MS,
      targetSource: readTarget,
    },
    {
      name: 'fx-estimate',
      label: 'POST /v1/wallets/estimate',
      method: 'POST',
      path: '/v1/wallets/estimate',
      body: () => JSON.stringify({ sourceCurrency: 'CAD', destinationCurrency: 'XOF', amount: '250.00' }),
      connections: CONNECTIONS,
      targetP95Ms: READ_TARGET_P95_MS,
      targetSource: readTarget,
    },
    {
      name: 'transfers',
      label: 'GET /v1/transfers?pageSize=20',
      method: 'GET',
      path: '/v1/transfers?page=1&pageSize=20',
      connections: CONNECTIONS,
      targetP95Ms: READ_TARGET_P95_MS,
      targetSource: readTarget,
    },
  ];
  if (process.env.LOAD_WRITES === '1') {
    scenarios.push({
      name: 'ledger-write',
      label: 'POST /v1/sandbox/wallets/self-deposit (0.01 CAD)',
      method: 'POST',
      path: '/v1/sandbox/wallets/self-deposit',
      body: () =>
        JSON.stringify({
          organizationId,
          currencyCode: 'CAD',
          amount: '0.01',
          idempotencyKey: `load-${randomUUID()}`,
        }),
      connections: 1,
      targetP95Ms: WRITE_TARGET_P95_MS,
      targetSource: 'PRD §5 : écriture ledger < 100 ms p95 hors contention',
    });
  }
  const only = (process.env.LOAD_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selected = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
  if (!selected.length)
    throw new Error(`LOAD_ONLY matched no scenario (${scenarios.map((s) => s.name).join(', ')})`);

  console.log('DFN load test — SANDBOX ONLY (fictitious data, no real funds)');
  console.log(
    `target ${BASE_URL} · user ${email} · ${CONNECTIONS} connections · ${DURATION} s per scenario (+${WARMUP} s warm-up) · client mode ${CLIENT_MODE}`,
  );
  console.log(
    `host: Node ${process.version}, ${cpus().length} CPU (${cpus()[0]?.model ?? 'unknown'}), ${Math.round(totalmem() / 2 ** 30)} GiB RAM · dataset visible to the user: ${dataset.transactions ?? '?'} transactions, ${dataset.transfers ?? '?'} transfers`,
  );

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    process.stdout.write(`  · ${scenario.name} …`);
    const r = await measure(scenario, cookie);
    results.push(r);
    process.stdout.write(
      ` p95 ${r.p95} ms, ${r.throughputRps} req/s, errors ${(r.errorRate * 100).toFixed(2)} %\n`,
    );
  }

  console.log(`\n${markdown(results)}\n`);
  if (process.env.LOAD_JSON) {
    writeFileSync(
      process.env.LOAD_JSON,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          baseUrl: BASE_URL,
          connections: CONNECTIONS,
          durationS: DURATION,
          warmupS: WARMUP,
          clientMode: CLIENT_MODE,
          node: process.version,
          cpus: cpus().length,
          dataset,
          results,
        },
        null,
        2,
      ),
    );
  }
  const failedScenarios = results.filter((r) => !r.pass);
  if (failedScenarios.length) {
    console.error(
      `FAILED: ${failedScenarios.map((r) => `${r.name} (p95 ${r.p95} ms / target ${r.targetP95Ms} ms, errors ${(r.errorRate * 100).toFixed(2)} %)`).join('; ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log('All scenarios within targets (p95 and error rate ≤ 1 %).');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
