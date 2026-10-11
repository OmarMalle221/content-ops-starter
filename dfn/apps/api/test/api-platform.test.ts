import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifySignature } from '@dfn/payment-adapters';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import { requiredScopeFor } from '../src/modules/api-platform/api-scopes';
import { SlidingWindowRateLimiter } from '../src/modules/api-platform/rate-limiter';
import { assertSafeWebhookUrl, isPrivateWebhookHost } from '../src/modules/api-platform/ssrf';
import { nextAttemptDelayMs } from '../src/modules/api-platform/webhook-dispatcher.service';
import { requestFingerprint } from '../src/modules/api-platform/idempotency.interceptor';
import {
  Client,
  PASSWORD,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { VEHICLE_TX } from './helpers/protect';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReceivedHook {
  path: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
}

/** Tiny webhook receiver: status per path is configurable, every request is recorded. */
class HookReceiver {
  server!: Server;
  port = 0;
  received: ReceivedHook[] = [];
  statusByPath = new Map<string, number>();

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const path = req.url ?? '/';
        this.received.push({ path, headers: req.headers, rawBody: raw });
        const status = this.statusByPath.get(path) ?? 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: status < 300 }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  url(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }
  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Bearer API-key client (no cookies). */
function keyClient(ctx: TestContext, key: string) {
  const auth = (r: any) => r.set('Authorization', `Bearer ${key}`);
  return {
    get: (url: string) => auth(ctx.http().get(url)),
    post: (url: string, body?: unknown, headers: Record<string, string> = {}) =>
      auth(
        ctx
          .http()
          .post(url)
          .set(headers)
          .send(body ?? {}),
      ),
    patch: (url: string, body?: unknown) =>
      auth(
        ctx
          .http()
          .patch(url)
          .send(body ?? {}),
      ),
    delete: (url: string) => auth(ctx.http().delete(url)),
  };
}

const ALL_SCOPES = ['transactions:read', 'transactions:write', 'webhooks:manage'];

async function createKey(client: Client, body: Record<string, unknown> = {}) {
  const res = await client.post('/v1/api-credentials', {
    name: 'Intégration ERP',
    scopes: ALL_SCOPES,
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { key: string; credential: any };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(100);
  }
}

let ctx: TestContext;
const receiver = new HookReceiver();
beforeAll(async () => {
  ctx = await bootTestApp();
  await receiver.start();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
  receiver.received = [];
  receiver.statusByPath.clear();
});
afterAll(async () => {
  await ctx.close();
  await receiver.stop();
});

describe('pure rules', () => {
  it('maps method + path to the required scope', () => {
    expect(requiredScopeFor('GET', '/v1/transactions?page=1')).toBe('transactions:read');
    expect(requiredScopeFor('GET', '/v1/invitations/abc')).toBe('transactions:read');
    expect(requiredScopeFor('POST', '/v1/transactions')).toBe('transactions:write');
    const id = '3f2b1c4d-1111-2222-3333-444444444444';
    expect(requiredScopeFor('POST', `/v1/transactions/${id}/accept-terms`)).toBe('transactions:write');
    expect(requiredScopeFor('POST', `/v1/transactions/${id}/documents`)).toBe('documents:write');
    expect(requiredScopeFor('POST', '/v1/documents')).toBe('documents:write');
    expect(requiredScopeFor('POST', `/v1/transactions/${id}/disputes`)).toBe('disputes:write');
    expect(requiredScopeFor('POST', `/v1/transactions/${id}/refund-request`)).toBe('disputes:write');
    expect(requiredScopeFor('POST', `/v1/disputes/${id}/messages`)).toBe('disputes:write');
    expect(requiredScopeFor('GET', `/v1/wallets/${id}/summary`)).toBe('wallets:read');
    expect(requiredScopeFor('GET', '/v1/transfers')).toBe('transfers:read');
    expect(requiredScopeFor('POST', '/v1/transfers')).toBe('transfers:write');
    expect(requiredScopeFor('GET', '/v1/invoices')).toBe('invoices:read');
    expect(requiredScopeFor('POST', '/v1/quotes')).toBe('invoices:write');
    expect(requiredScopeFor('DELETE', `/v1/webhooks/${id}`)).toBe('webhooks:manage');
    expect(requiredScopeFor('GET', '/v1/reference/countries')).toBeNull();
    expect(requiredScopeFor('GET', '/v1/health')).toBeNull();
    expect(requiredScopeFor('GET', '/v1/admin/stats')).toBe('FORBIDDEN');
    expect(requiredScopeFor('POST', '/v1/api-credentials')).toBe('FORBIDDEN');
    expect(requiredScopeFor('GET', '/v1/auth/me')).toBe('FORBIDDEN');
    expect(requiredScopeFor('DELETE', `/v1/transactions/${id}`)).toBe('FORBIDDEN');
  });

  it('applies a sliding window per key', () => {
    const limiter = new SlidingWindowRateLimiter(60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(limiter.hit('k', 3, t0 + i).allowed).toBe(true);
    const refused = limiter.hit('k', 3, t0 + 10);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
    expect(limiter.hit('other', 3, t0 + 10).allowed).toBe(true);
    expect(limiter.hit('k', 3, t0 + 60_001).allowed).toBe(true);
  });

  it('rejects private webhook hosts outside the test environment', () => {
    for (const host of [
      'localhost',
      'api.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.9',
      '169.254.169.254',
      '::1',
      '172.16.5.5',
    ])
      expect(isPrivateWebhookHost(host), host).toBe(true);
    expect(isPrivateWebhookHost('partner.example.com')).toBe(false);
    expect(() => assertSafeWebhookUrl('http://127.0.0.1:9/hook', 'production')).toThrow(/public host/);
    expect(() => assertSafeWebhookUrl('https://user:pw@partner.example.com/hook', 'production')).toThrow(
      /credentials/,
    );
    expect(assertSafeWebhookUrl('https://partner.example.com/hook', 'production').hostname).toBe(
      'partner.example.com',
    );
    expect(assertSafeWebhookUrl('http://127.0.0.1:9/hook', 'test').hostname).toBe('127.0.0.1');
  });

  it('computes back-off delays and stable request fingerprints', () => {
    expect(nextAttemptDelayMs(1)).toBe(2 * 60_000);
    expect(nextAttemptDelayMs(3)).toBe(8 * 60_000);
    const a = requestFingerprint('POST', '/v1/transactions', { b: 1, a: [1, 2] });
    expect(a).toBe(requestFingerprint('post', '/v1/transactions', { a: [1, 2], b: 1 }));
    expect(a).not.toBe(requestFingerprint('POST', '/v1/transactions', { b: 2, a: [1, 2] }));
  });
});

describe('API credentials', () => {
  it('creates a sandbox key shown once, lists masked keys, rotates and revokes with audit', async () => {
    const { client: owner, user } = await registerUser(ctx, 'dev@example.com');
    const personalOrgId = user.organizations[0].id as string;
    const created = await createKey(owner, { rateLimitPerMinute: 60, expiresInDays: 30 });
    expect(created.key).toMatch(/^dfn_sk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.credential.organizationId).toBe(personalOrgId);
    expect(created.credential.status).toBe('ACTIVE');
    expect(created.credential.keyDisplay.startsWith(`dfn_sk_${created.credential.keyPrefix}_`)).toBe(true);
    expect(created.credential.nextActions).toEqual(['ROTATE', 'REVOKE']);
    expect(created.credential.expiresAt).not.toBeNull();
    expect(created.credential.sandbox).toBe(true);
    expect(created.credential.keyHash).toBeUndefined();

    const row = await ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: created.credential.id } });
    expect(row.keyHash).toHaveLength(64);
    expect(row.keyHash).not.toContain(created.key.slice(-10));
    expect(row.createdByUserId).toBe(user.id);

    const list = await owner.get(`/v1/api-credentials?organizationId=${personalOrgId}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.key);

    const rotated = await owner.post(`/v1/api-credentials/${created.credential.id}/rotate`);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    expect(rotated.body.key).not.toBe(created.key);
    expect(rotated.body.credential.rotatedFromId).toBe(created.credential.id);
    const old = await ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: created.credential.id } });
    expect(old.revokedAt).not.toBeNull();
    expect((await keyClient(ctx, created.key).get('/v1/transactions')).status).toBe(401);
    expect((await keyClient(ctx, rotated.body.key).get('/v1/transactions')).status).toBe(200);

    const revoked = await owner.delete(`/v1/api-credentials/${rotated.body.credential.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('REVOKED');
    expect((await owner.delete(`/v1/api-credentials/${rotated.body.credential.id}`)).status).toBe(409);

    const actions = (
      await ctx.prisma.auditLog.findMany({
        where: { entityType: 'ApiCredential' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(['api_credential.created', 'api_credential.rotated', 'api_credential.revoked']);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: user.id, type: { startsWith: 'api_credential.' } },
      }),
    ).toBe(3);
    const withRevoked = await owner.get(
      `/v1/api-credentials?organizationId=${personalOrgId}&includeRevoked=true`,
    );
    expect(withRevoked.body.items).toHaveLength(2);
  });

  it('validates input and refuses other tenants (404) and insufficient roles (403)', async () => {
    const { client: owner } = await registerUser(ctx, 'owner@example.com');
    const { client: stranger } = await registerUser(ctx, 'stranger@example.com');
    expect((await owner.post('/v1/api-credentials', { name: 'x', scopes: [] })).status).toBe(400);
    expect((await owner.post('/v1/api-credentials', { name: 'Clé', scopes: ['nope:scope'] })).status).toBe(
      400,
    );
    const created = await createKey(owner);

    expect((await stranger.get(`/v1/api-credentials/${created.credential.id}`)).status).toBe(404);
    expect((await stranger.post(`/v1/api-credentials/${created.credential.id}/rotate`)).status).toBe(404);
    expect((await stranger.delete(`/v1/api-credentials/${created.credential.id}`)).status).toBe(404);
    expect((await stranger.get(`/v1/api-credentials/${created.credential.id}/logs`)).status).toBe(404);

    // A VIEWER of a business organisation lacks API_MANAGE → 403
    const org = await owner.post('/v1/organizations', {
      name: 'Dakar Auto Import',
      country: 'SN',
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
    });
    expect(org.status).toBe(201);
    const invite = await owner.post(`/v1/organizations/${org.body.id}/members/invite`, {
      email: 'viewer@example.com',
      role: 'VIEWER',
    });
    const { client: viewer } = await registerUser(ctx, 'viewer@example.com');
    expect(
      (await viewer.post('/v1/organizations/invitations/accept', { token: invite.body.token })).status,
    ).toBe(201);
    await viewer.post('/v1/auth/login', { email: 'viewer@example.com', password: PASSWORD });
    const denied = await viewer.post('/v1/api-credentials', {
      organizationId: org.body.id,
      name: 'Clé viewer',
      scopes: ['transactions:read'],
    });
    expect(denied.status).toBe(403);
    expect((await viewer.get(`/v1/api-credentials?organizationId=${org.body.id}`)).status).toBe(403);
    // The owner can create a key for the business organisation
    const bizKey = await createKey(owner, { organizationId: org.body.id });
    expect(bizKey.credential.organizationId).toBe(org.body.id);
    // Staff do not get a bypass on tenant keys (resolveActingOrganization semantics)
    await promote(ctx, 'stranger@example.com', 'ADMIN');
    await stranger.post('/v1/auth/login', { email: 'stranger@example.com', password: PASSWORD });
    expect((await stranger.get(`/v1/api-credentials?organizationId=${org.body.id}`)).status).toBe(404);
  });
});

describe('API-key authentication, scopes and rate limits', () => {
  it('authenticates with Bearer dfn_sk_, isolates the tenant and enforces scopes', async () => {
    const { client: owner, user } = await registerUser(ctx, 'dev@example.com');
    const personalOrgId = user.organizations[0].id as string;
    const { client: other } = await registerUser(ctx, 'other@example.com');
    // Data of two tenants
    const mine = await owner.post('/v1/transactions', VEHICLE_TX);
    expect(mine.status).toBe(201);
    const theirs = await other.post('/v1/transactions', { ...VEHICLE_TX, title: 'Autre tenant' });
    expect(theirs.status).toBe(201);

    const full = await createKey(owner);
    const api = keyClient(ctx, full.key);
    const list = await api.get('/v1/transactions');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((t: any) => t.id)).toEqual([mine.body.id]);
    expect(list.headers['x-dfn-mode']).toBe('sandbox');
    expect(list.headers['x-ratelimit-limit']).toBe('120');
    expect((await api.get(`/v1/transactions/${theirs.body.id}`)).status).toBe(404);
    expect((await api.get(`/v1/transactions/${mine.body.id}`)).status).toBe(200);
    expect((await api.get('/v1/reference')).status).toBe(200);

    // Missing scope → 403 SCOPE_FORBIDDEN; routes closed to keys → 403 as well
    const readOnly = await createKey(owner, { name: 'Lecture seule', scopes: ['transactions:read'] });
    const ro = keyClient(ctx, readOnly.key);
    expect((await ro.get('/v1/transactions')).status).toBe(200);
    const denied = await ro.post('/v1/transactions', VEHICLE_TX);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('SCOPE_FORBIDDEN');
    expect(denied.body.details.requiredScope).toBe('transactions:write');
    const wallets = await ro.get(`/v1/wallets/${personalOrgId}`);
    expect(wallets.status).toBe(403);
    expect(wallets.body.code).toBe('SCOPE_FORBIDDEN');
    const admin = await api.get('/v1/admin/stats');
    expect(admin.status).toBe(403);
    expect((await api.get('/v1/auth/me')).status).toBe(403);
    expect(
      (await api.post('/v1/api-credentials', { name: 'Clé via clé', scopes: ['transactions:read'] })).status,
    ).toBe(403);

    // Unknown, revoked and expired keys → 401
    const unknown = await keyClient(ctx, 'dfn_sk_abcdefgh_' + 'x'.repeat(43)).get('/v1/transactions');
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('API_KEY_INVALID');
    expect((await owner.delete(`/v1/api-credentials/${readOnly.credential.id}`)).status).toBe(200);
    const revoked = await ro.get('/v1/transactions');
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('API_KEY_REVOKED');
    await ctx.prisma.apiCredential.update({
      where: { id: full.credential.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await api.get('/v1/transactions');
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('API_KEY_EXPIRED');

    // lastUsedAt was stamped and the journal recorded the key's requests (including refusals)
    const row = await ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: readOnly.credential.id } });
    expect(row.lastUsedAt).not.toBeNull();
    const logs = await waitFor(async () => {
      const r = await owner.get(`/v1/api-credentials/${readOnly.credential.id}/logs?pageSize=10`);
      return r.body.total >= 4 ? r.body : null;
    });
    const statuses = logs.items.map((l: any) => l.statusCode).sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(403);
    expect(statuses).toContain(401);
    expect(logs.items[0].path).toMatch(/^\/v1\//);
  });

  it('rate-limits per key with Retry-After (10 per minute → the 11th call is refused)', async () => {
    const { client: owner } = await registerUser(ctx, 'dev@example.com');
    const limited = await createKey(owner, { name: 'Limitée', rateLimitPerMinute: 10 });
    const api = keyClient(ctx, limited.key);
    for (let i = 0; i < 10; i++) {
      const r = await api.get('/v1/transactions');
      expect(r.status, `call ${i + 1}`).toBe(200);
      expect(r.headers['x-ratelimit-remaining']).toBe(String(9 - i));
    }
    const refused = await api.get('/v1/transactions');
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another key of the same organisation is not affected
    const other = await createKey(owner, { name: 'Autre', rateLimitPerMinute: 10 });
    expect((await keyClient(ctx, other.key).get('/v1/transactions')).status).toBe(200);
  });

  it('refuses a key once its creator loses API_MANAGE or leaves the organisation', async () => {
    const { client: owner } = await registerUser(ctx, 'owner@example.com');
    const org = await owner.post('/v1/organizations', {
      name: 'Dakar Auto Import',
      country: 'SN',
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
    });
    expect(org.status).toBe(201);
    const invite = await owner.post(`/v1/organizations/${org.body.id}/members/invite`, {
      email: 'integrator@example.com',
      role: 'ADMIN',
    });
    expect(invite.status).toBe(201);
    const { client: integrator, user: integratorUser } = await registerUser(ctx, 'integrator@example.com');
    expect(
      (await integrator.post('/v1/organizations/invitations/accept', { token: invite.body.token })).status,
    ).toBe(201);
    await integrator.post('/v1/auth/login', { email: 'integrator@example.com', password: PASSWORD });
    const { key, credential } = await createKey(integrator, { organizationId: org.body.id });
    const api = keyClient(ctx, key);
    expect((await api.get('/v1/transactions')).status).toBe(200);
    const membership = await ctx.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: org.body.id, userId: integratorUser.id },
    });
    const memberUrl = `/v1/organizations/${org.body.id}/members/${membership.id}`;

    // Demoted to VIEWER (no API_MANAGE): the key stops working although it was never revoked.
    expect((await owner.patch(memberUrl, { role: 'VIEWER' })).status).toBe(200);
    const demoted = await api.get('/v1/transactions');
    expect(demoted.status).toBe(401);
    expect(demoted.body.code).toBe('API_KEY_REVOKED');
    expect(
      (await ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: credential.id } })).revokedAt,
    ).toBeNull();
    // Promoted back: the key works again.
    expect((await owner.patch(memberUrl, { role: 'ADMIN' })).status).toBe(200);
    expect((await api.get('/v1/transactions')).status).toBe(200);

    // Removed from the organisation: refused, and the refusal is journaled under the credential.
    expect((await owner.delete(memberUrl)).status).toBe(200);
    const removed = await api.get('/v1/transactions');
    expect(removed.status).toBe(401);
    expect(removed.body.code).toBe('API_KEY_REVOKED');
    const logs = await waitFor(async () => {
      const r = await owner.get(`/v1/api-credentials/${credential.id}/logs?pageSize=10`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.items.filter((l: any) => l.statusCode === 401).length >= 2 ? r.body : null;
    });
    expect(logs.items.some((l: any) => l.statusCode === 200)).toBe(true);
  });
});

describe('Idempotency-Key', () => {
  it('replays the stored response for the same request and rejects reuse with another body', async () => {
    const { client: owner, user } = await registerUser(ctx, 'dev@example.com');
    const personalOrgId = user.organizations[0].id as string;
    const { key } = await createKey(owner);
    const api = keyClient(ctx, key);
    const headers = { 'Idempotency-Key': 'order-2026-0001' };

    const first = await api.post('/v1/transactions', VEHICLE_TX, headers);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const second = await api.post('/v1/transactions', VEHICLE_TX, headers);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.reference).toBe(first.body.reference);
    expect(await ctx.prisma.transaction.count({ where: { buyerOrganizationId: personalOrgId } })).toBe(1);

    const reused = await api.post('/v1/transactions', { ...VEHICLE_TX, title: 'Autre commande' }, headers);
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await ctx.prisma.transaction.count({ where: { buyerOrganizationId: personalOrgId } })).toBe(1);

    // Invalid header → 400; failed requests are not stored (the key can be retried)
    expect((await api.post('/v1/transactions', VEHICLE_TX, { 'Idempotency-Key': 'short' })).status).toBe(400);
    const bad = { ...VEHICLE_TX, amount: '1.00' };
    const failing = { 'Idempotency-Key': 'order-2026-0002' };
    expect((await api.post('/v1/transactions', bad, failing)).status).toBe(400);
    expect(await ctx.prisma.idempotencyRecord.count({ where: { idempotencyKey: 'order-2026-0002' } })).toBe(
      0,
    );
    const retried = await api.post('/v1/transactions', { ...VEHICLE_TX, title: 'Deuxième' }, failing);
    expect(retried.status).toBe(201);

    // Records are scoped per credential: another key may use the same Idempotency-Key value
    const { key: otherKey } = await createKey(owner, { name: 'Deuxième clé' });
    const otherFirst = await keyClient(ctx, otherKey).post(
      '/v1/transactions',
      { ...VEHICLE_TX, title: 'Clé 2' },
      headers,
    );
    expect(otherFirst.status).toBe(201);
    expect(otherFirst.body.id).not.toBe(first.body.id);

    // Sessions are scoped by user; concurrent duplicates are refused while in flight
    await ctx.prisma.idempotencyRecord.create({
      data: {
        scopeKey: user.id,
        idempotencyKey: 'in-flight-0001',
        method: 'POST',
        path: '/v1/transactions',
        requestHash: 'whatever',
        statusCode: 0,
        responseBody: {},
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const inFlight = await ctx
      .http()
      .post('/v1/transactions')
      .set('Cookie', (owner as any).cookie)
      .set('Idempotency-Key', 'in-flight-0001')
      .send(VEHICLE_TX);
    expect([409, 422]).toContain(inFlight.status);

    // Expired records are purged by the WEBHOOK_RETRY job
    await ctx.prisma.idempotencyRecord.updateMany({
      where: { idempotencyKey: 'order-2026-0001' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const run = await ctx.app.get(MaintenanceService).run('WEBHOOK_RETRY', 'test');
    expect(run.status).toBe('COMPLETED');
    expect((run.summary as any).idempotencyRecordsPurged).toBe(2);
  });
});

describe('webhooks', () => {
  it('delivers a signed transaction.created event, supports test events, rotation and tenant isolation', async () => {
    const { client: owner, user } = await registerUser(ctx, 'dev@example.com');
    const personalOrgId = user.organizations[0].id as string;
    const { client: stranger } = await registerUser(ctx, 'stranger@example.com');

    const created = await owner.post('/v1/webhooks', {
      url: receiver.url('/ok'),
      description: 'ERP partenaire',
      events: ['transaction.created', 'transaction.settled'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const webhookId = created.body.webhook.id as string;
    expect(created.body.webhook.status).toBe('ACTIVE');
    expect(created.body.webhook.secretEnc).toBeUndefined();
    const stored = await ctx.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: webhookId } });
    expect(stored.secretEnc).not.toContain(secret.slice(6, 20));

    // Transaction created with the session → event → signed delivery
    const tx = await owner.post('/v1/transactions', VEHICLE_TX);
    expect(tx.status).toBe(201);
    const delivery = await waitFor(() =>
      ctx.prisma.webhookDelivery.findFirst({
        where: { subscriptionId: webhookId, eventType: 'transaction.created', status: 'DELIVERED' },
      }),
    );
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastStatusCode).toBe(200);
    expect(delivery.deliveredAt).not.toBeNull();
    const hit = receiver.received.find((r) => r.headers['x-dfn-delivery'] === delivery.id)!;
    expect(hit).toBeDefined();
    expect(hit.headers['x-dfn-event']).toBe('transaction.created');
    expect(hit.headers['content-type']).toBe('application/json');
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['x-dfn-signature'] as string)!;
    expect(sig).not.toBeNull();
    expect(verifySignature(secret, sig[1]!, hit.rawBody, sig[2]!)).toBe(true);
    expect(verifySignature('whsec_wrong', sig[1]!, hit.rawBody, sig[2]!)).toBe(false);
    const body = JSON.parse(hit.rawBody);
    expect(body).toMatchObject({ type: 'transaction.created', sandbox: true, id: delivery.eventId });
    expect(body.data.transactionId).toBe(tx.body.id);
    expect(body.data.reference).toBe(tx.body.reference);
    expect(hit.headers['x-dfn-signature']).toBe(delivery.signature);

    // Deliveries listing, DTO shape, no secret anywhere
    const deliveries = await owner.get(`/v1/webhooks/${webhookId}/deliveries`);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.total).toBe(1);
    expect(deliveries.body.items[0].status).toBe('DELIVERED');
    expect(deliveries.body.items[0].nextActions).toEqual([]);
    expect(JSON.stringify(deliveries.body)).not.toContain(secret);

    // Retrying a DELIVERED delivery is an invalid transition
    const badRetry = await owner.post(`/v1/webhooks/${webhookId}/deliveries/${delivery.id}/retry`);
    expect(badRetry.status).toBe(409);
    expect(badRetry.body.code).toBe('INVALID_TRANSITION');

    // Test event
    const test = await owner.post(`/v1/webhooks/${webhookId}/test`, { eventType: 'invoice.paid' });
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body.status).toBe('DELIVERED');
    expect(test.body.payload.data.test).toBe(true);
    expect(test.body.eventType).toBe('invoice.paid');

    // Disable → no delivery for the next event; re-enable
    expect((await owner.patch(`/v1/webhooks/${webhookId}`, { isActive: false })).body.status).toBe(
      'INACTIVE',
    );
    await owner.post('/v1/transactions', { ...VEHICLE_TX, title: 'Pendant pause' });
    await sleep(400);
    expect(await ctx.prisma.webhookDelivery.count({ where: { subscriptionId: webhookId } })).toBe(2);
    expect((await owner.patch(`/v1/webhooks/${webhookId}`, { isActive: true })).body.status).toBe('ACTIVE');

    // Secret rotation: the new secret signs the next deliveries
    const rotated = await owner.post(`/v1/webhooks/${webhookId}/rotate-secret`);
    expect(rotated.status).toBe(200);
    const newSecret = rotated.body.secret as string;
    expect(newSecret).not.toBe(secret);
    const test2 = await owner.post(`/v1/webhooks/${webhookId}/test`, {});
    expect(test2.body.status).toBe('DELIVERED');
    const hit2 = receiver.received.find((r) => r.headers['x-dfn-delivery'] === test2.body.id)!;
    const sig2 = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit2.headers['x-dfn-signature'] as string)!;
    expect(verifySignature(newSecret, sig2[1]!, hit2.rawBody, sig2[2]!)).toBe(true);
    expect(verifySignature(secret, sig2[1]!, hit2.rawBody, sig2[2]!)).toBe(false);

    // Tenant isolation (404) and management through an API key carrying webhooks:manage
    expect((await stranger.get(`/v1/webhooks/${webhookId}`)).status).toBe(404);
    expect((await stranger.patch(`/v1/webhooks/${webhookId}`, { isActive: false })).status).toBe(404);
    expect((await stranger.get(`/v1/webhooks/${webhookId}/deliveries`)).status).toBe(404);
    expect((await stranger.delete(`/v1/webhooks/${webhookId}`)).status).toBe(404);
    const { key } = await createKey(owner, { scopes: ['webhooks:manage'] });
    const api = keyClient(ctx, key);
    const viaKey = await api.get('/v1/webhooks');
    expect(viaKey.status).toBe(200);
    expect(viaKey.body.organizationId).toBe(personalOrgId);
    expect(viaKey.body.items.map((w: any) => w.id)).toEqual([webhookId]);
    const strangerOrg = (await stranger.get('/v1/auth/me')).body.user.organizations[0].id;
    expect((await api.get(`/v1/webhooks?organizationId=${strangerOrg}`)).status).toBe(404);
    const { key: noScope } = await createKey(owner, { name: 'Sans webhooks', scopes: ['transactions:read'] });
    expect((await keyClient(ctx, noScope).get('/v1/webhooks')).status).toBe(403);

    // Validation
    expect(
      (await owner.post('/v1/webhooks', { url: 'ftp://x', events: ['transaction.created'] })).status,
    ).toBe(400);
    expect((await owner.post('/v1/webhooks', { url: receiver.url('/ok'), events: ['nope'] })).status).toBe(
      400,
    );

    // Soft delete keeps history
    const removed = await owner.delete(`/v1/webhooks/${webhookId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.status).toBe('REVOKED');
    expect((await owner.post(`/v1/webhooks/${webhookId}/test`, {})).status).toBe(409);
    expect((await owner.get(`/v1/webhooks?organizationId=${personalOrgId}`)).body.items).toHaveLength(0);
    expect(
      (await owner.get(`/v1/webhooks?organizationId=${personalOrgId}&includeRevoked=true`)).body.items,
    ).toHaveLength(1);

    const actions = (
      await ctx.prisma.auditLog.findMany({
        where: { entityType: { in: ['WebhookSubscription', 'WebhookDelivery'] } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      'webhook.created',
      'webhook.test_sent',
      'webhook.updated',
      'webhook.updated',
      'webhook.secret_rotated',
      'webhook.test_sent',
      'webhook.deleted',
    ]);
  });

  it('schedules retries for failing endpoints, replays them with WEBHOOK_RETRY and exhausts eventually', async () => {
    const { client: owner } = await registerUser(ctx, 'dev@example.com');
    receiver.statusByPath.set('/fail', 500);
    const created = await owner.post('/v1/webhooks', {
      url: receiver.url('/fail'),
      events: ['transaction.created'],
    });
    expect(created.status).toBe(201);
    const webhookId = created.body.webhook.id as string;

    await owner.post('/v1/transactions', VEHICLE_TX);
    const failed = await waitFor(() =>
      ctx.prisma.webhookDelivery.findFirst({ where: { subscriptionId: webhookId, status: 'FAILED' } }),
    );
    expect(failed.attempts).toBe(1);
    expect(failed.lastStatusCode).toBe(500);
    expect(failed.lastError).toBe('HTTP 500');
    expect(failed.nextAttemptAt).not.toBeNull();
    // Back-off: 2^1 minutes after the first failure (±5 s tolerance)
    const delay = failed.nextAttemptAt!.getTime() - Date.now();
    expect(delay).toBeGreaterThan(110_000);
    expect(delay).toBeLessThanOrEqual(120_000);
    const sub = await ctx.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: webhookId } });
    expect(sub.failureCount).toBe(1);
    const dto = await owner.get(`/v1/webhooks/${webhookId}/deliveries?status=FAILED`);
    expect(dto.body.items[0].nextActions).toEqual(['RETRY']);

    // Not due yet → the job leaves it alone
    const maintenance = ctx.app.get(MaintenanceService);
    const idle = await maintenance.run('WEBHOOK_RETRY', 'test');
    expect(idle.status).toBe('COMPLETED');
    expect((idle.summary as any).due).toBe(0);
    expect((await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failed.id } })).attempts).toBe(
      1,
    );

    // Due → retried (still failing: attempts 2, back-off 4 minutes)
    await ctx.prisma.webhookDelivery.update({
      where: { id: failed.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const retried = await maintenance.run('WEBHOOK_RETRY', 'test');
    expect(retried.summary as any).toMatchObject({ due: 1, failed: 1, delivered: 0 });
    const afterRetry = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failed.id } });
    expect(afterRetry.attempts).toBe(2);
    expect(afterRetry.status).toBe('FAILED');
    const delay2 = afterRetry.nextAttemptAt!.getTime() - Date.now();
    expect(delay2).toBeGreaterThan(230_000);

    // Endpoint recovers → manual retry succeeds, failure counter resets
    receiver.statusByPath.set('/fail', 200);
    const manual = await owner.post(`/v1/webhooks/${webhookId}/deliveries/${failed.id}/retry`);
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(manual.body.status).toBe('DELIVERED');
    expect(manual.body.attempts).toBe(3);
    expect(
      (await ctx.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: webhookId } })).failureCount,
    ).toBe(0);

    // Exhaustion after WEBHOOK_MAX_ATTEMPTS (default 6)
    receiver.statusByPath.set('/fail', 503);
    const exhaustedTest = await owner.post(`/v1/webhooks/${webhookId}/test`, {});
    expect(exhaustedTest.body.status).toBe('FAILED');
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.webhookDelivery.update({
        where: { id: exhaustedTest.body.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await maintenance.run('WEBHOOK_RETRY', 'test');
    }
    const exhausted = await ctx.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: exhaustedTest.body.id },
    });
    expect(exhausted.status).toBe('EXHAUSTED');
    expect(exhausted.attempts).toBe(6);
    expect(exhausted.nextAttemptAt).toBeNull();
    const retryExhausted = await owner.get(`/v1/webhooks/${webhookId}/deliveries?status=EXHAUSTED`);
    expect(retryExhausted.body.items[0].nextActions).toEqual(['RETRY']);
  });
});
