import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';
import { DomainError } from '../src/common/domain-error';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisThrottlerStorage } from '../src/common/throttler';
import { ENV, type Env } from '../src/config/env';
import { ApiAuthService } from '../src/modules/api-platform/api-auth.service';
import { RedisRateLimitStore } from '../src/modules/api-platform/rate-limiter';
import {
  STALE_PENDING_AFTER_MS,
  WebhookDispatcherService,
} from '../src/modules/api-platform/webhook-dispatcher.service';
import { JobLeaseStore } from '../src/modules/jobs/job-lease';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import {
  BULLMQ_TRIGGER,
  JobsSchedulerService,
  MAINTENANCE_QUEUE,
  schedulerIdFor,
} from '../src/modules/jobs/jobs-scheduler.service';
import {
  LEASE_EXPIRED,
  LEASE_LOST,
  LeaseLostError,
  MaintenanceService,
} from '../src/modules/jobs/maintenance.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { bootTestApp, promote, registerUser, resetDatabase, type TestContext } from './helpers/app';

/**
 * Distributed scheduler: job leases (several runners with distinct INSTANCE_IDs), the BullMQ
 * driver (two API instances sharing one Redis), Redis-backed rate limits and the stale PENDING
 * webhook sweep. Redis tests use database 5 of TEST_REDIS_URL (flushed here, never FLUSHALL).
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:63790/5';

async function probeRedis(url: string): Promise<boolean> {
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1_000 });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/** Set by the root beforeAll; Redis/BullMQ tests are skipped (with a warning) when unreachable. */
let redisAvailable = false;

async function detectRedis(): Promise<void> {
  redisAvailable = await probeRedis(REDIS_URL);
  if (!redisAvailable && process.env.TEST_REDIS_URL) {
    throw new Error(`TEST_REDIS_URL=${process.env.TEST_REDIS_URL} is not reachable`);
  }
  if (!redisAvailable) {
    console.warn(`[jobs-distributed] Redis not reachable at ${REDIS_URL} — Redis/BullMQ tests skipped`);
  }
}

/** First statement of every Redis test. */
function requireRedis(context: { skip: (note?: string) => void }) {
  if (!redisAvailable) context.skip(`Redis not reachable at ${REDIS_URL}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(50);
  }
}

let ctx: TestContext;
let baseEnv: Env;

beforeAll(async () => {
  await detectRedis();
  ctx = await bootTestApp();
  baseEnv = ctx.app.get<Env>(ENV);
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

/** A MaintenanceService as another API replica would build it (own INSTANCE_ID, short lease). */
function runner(instanceId: string, registry: JobRegistry, leaseSeconds = 2) {
  return new MaintenanceService(ctx.prisma, registry, {
    ...baseEnv,
    INSTANCE_ID: instanceId,
    JOB_LEASE_SECONDS: leaseSeconds,
  });
}

const leaseOf = (jobName: 'BALANCE_SNAPSHOTS' | 'RECONCILIATION' | 'EXPIRE_STALE' | 'INVOICE_OVERDUE') =>
  ctx.prisma.jobLease.findUnique({ where: { jobName } });

describe('job leases (several runners)', () => {
  it('never runs the same job concurrently on two instances (409 JOB_ALREADY_RUNNING)', async () => {
    const registry = new JobRegistry();
    const started = deferred();
    const release = deferred();
    let concurrent = 0;
    let maxConcurrent = 0;
    registry.register('BALANCE_SNAPSHOTS', async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      started.resolve();
      await release.promise;
      await sleep(50);
      concurrent--;
      return { summary: { ok: true } };
    });
    const a = runner('replica-a', registry);
    const b = runner('replica-b', registry);

    const runA = a.run('BALANCE_SNAPSHOTS', 'test:a');
    await started.promise;
    const refused = await b.run('BALANCE_SNAPSHOTS', 'test:b').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(DomainError);
    expect(refused).toMatchObject({ code: 'JOB_ALREADY_RUNNING', status: 409 });
    expect((refused as DomainError).details).toMatchObject({
      jobName: 'BALANCE_SNAPSHOTS',
      ownerId: 'replica-a',
    });
    const held = await leaseOf('BALANCE_SNAPSHOTS');
    expect(held?.ownerId).toBe('replica-a');

    release.resolve();
    const done = await runA;
    expect(done.status).toBe('COMPLETED');
    expect(done.instanceId).toBe('replica-a');
    expect(held?.runId).toBe(done.id);
    expect(await ctx.prisma.jobLease.count()).toBe(0); // released by its owner

    // Simultaneous starts on both instances: exactly one wins the lease.
    const results = await Promise.allSettled([
      a.run('BALANCE_SNAPSHOTS', 'test:a'),
      b.run('BALANCE_SNAPSHOTS', 'test:b'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason.code).toBe('JOB_ALREADY_RUNNING');

    // Once released, the other instance may run it.
    const byB = await b.run('BALANCE_SNAPSHOTS', 'test:b');
    expect(byB.instanceId).toBe('replica-b');
    expect(maxConcurrent).toBe(1);
    expect(await ctx.prisma.maintenanceRun.count({ where: { jobName: 'BALANCE_SNAPSHOTS' } })).toBe(3);
  });

  it('takes over an expired lease and closes the RUNNING run of the crashed replica as FAILED', async () => {
    const registry = new JobRegistry();
    registry.register('RECONCILIATION', async () => ({ summary: { reconciled: true } }));
    const b = runner('replica-b', registry);
    const now = Date.now();
    const stale = await ctx.prisma.maintenanceRun.create({
      data: {
        jobName: 'RECONCILIATION',
        triggeredBy: 'scheduler',
        instanceId: 'crashed-replica',
        startedAt: new Date(now - 10 * 60_000),
        heartbeatAt: new Date(now - 5 * 60_000),
      },
    });
    await ctx.prisma.jobLease.create({
      data: {
        jobName: 'RECONCILIATION',
        ownerId: 'crashed-replica',
        runId: stale.id,
        acquiredAt: new Date(now - 10 * 60_000),
        heartbeatAt: new Date(now - 5 * 60_000),
        expiresAt: new Date(now + 60_000),
      },
    });
    // While the lease is live, nobody else may run the job.
    await expect(b.run('RECONCILIATION', 'test')).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });

    // The owner crashed: no more heartbeats, the lease expires.
    await ctx.prisma.jobLease.update({
      where: { jobName: 'RECONCILIATION' },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const run = await b.run('RECONCILIATION', 'test');
    expect(run.status).toBe('COMPLETED');
    expect(run.instanceId).toBe('replica-b');

    const closed = await ctx.prisma.maintenanceRun.findUniqueOrThrow({ where: { id: stale.id } });
    expect(closed.status).toBe('FAILED');
    expect(closed.finishedAt).not.toBeNull();
    expect(closed.error).toContain(LEASE_EXPIRED);
    expect(closed.error).toContain('crashed-replica');
    expect(closed.error).toContain('replica-b');
    expect(await ctx.prisma.jobLease.count()).toBe(0);
  });

  it('renews the lease by heartbeat while a slow handler runs', async () => {
    const registry = new JobRegistry();
    let abortedDuringRun = false;
    registry.register('EXPIRE_STALE', async ({ signal }) => {
      await sleep(3_200);
      abortedDuringRun = Boolean(signal?.aborted);
      return { summary: { slow: true } };
    });
    const a = runner('replica-a', registry, 2);
    const b = runner('replica-b', registry, 2);
    const pending = a.run('EXPIRE_STALE', 'test');
    const first = await waitFor(() => leaseOf('EXPIRE_STALE'));

    await sleep(2_500); // beyond the initial 2 s lease
    const renewed = await leaseOf('EXPIRE_STALE');
    expect(renewed?.ownerId).toBe('replica-a');
    expect(renewed!.heartbeatAt.getTime()).toBeGreaterThan(first.heartbeatAt.getTime());
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    expect(renewed!.acquiredAt.getTime()).toBe(first.acquiredAt.getTime());
    await expect(b.run('EXPIRE_STALE', 'test')).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });

    const run = await pending;
    expect(run.status).toBe('COMPLETED');
    expect(abortedDuringRun).toBe(false);
    expect(run.heartbeatAt!.getTime()).toBeGreaterThan(run.startedAt.getTime() + 500);
    expect(await leaseOf('EXPIRE_STALE')).toBeNull();
  });

  it('aborts the handler through its signal when the lease is lost, and closes the run FAILED', async () => {
    const registry = new JobRegistry();
    const observed = deferred<unknown>();
    registry.register(
      'INVOICE_OVERDUE',
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            observed.resolve(signal!.reason);
            reject(signal!.reason as Error);
          });
        }),
    );
    const a = runner('replica-a', registry, 2);
    const pending = a.run('INVOICE_OVERDUE', 'test');
    await waitFor(() => leaseOf('INVOICE_OVERDUE'));
    // Another instance took the lease over (e.g. after a long pause of this replica).
    const thiefRun = randomUUID();
    await ctx.prisma.jobLease.update({
      where: { jobName: 'INVOICE_OVERDUE' },
      data: { ownerId: 'replica-thief', runId: thiefRun },
    });
    const reason = await observed.promise;
    expect(reason).toBeInstanceOf(LeaseLostError);
    const run = await pending;
    expect(run.status).toBe('FAILED');
    expect(run.error?.startsWith(LEASE_LOST)).toBe(true);
    // The loser never deletes the new owner's lease.
    const lease = await leaseOf('INVOICE_OVERDUE');
    expect(lease).toMatchObject({ ownerId: 'replica-thief', runId: thiefRun });
  });

  it('aborts before the lease can expire when renewals hang (local deadline)', async () => {
    const registry = new JobRegistry();
    const observed = deferred<unknown>();
    registry.register(
      'EXPIRE_STALE',
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            observed.resolve(signal!.reason);
            reject(signal!.reason as Error);
          });
        }),
    );
    const a = runner('replica-hang', registry, 2);
    // Every renewal hangs forever (pool exhausted, network partition): nothing settles.
    (a as unknown as { heartbeat: () => Promise<boolean> }).heartbeat = () => new Promise(() => undefined);
    const t0 = Date.now();
    const run = await a.run('EXPIRE_STALE', 'test');
    const elapsed = Date.now() - t0;
    expect(await observed.promise).toBeInstanceOf(LeaseLostError);
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain(LEASE_LOST);
    // Lease 2 s: the replica gives up before the database lease could be taken over.
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
  });

  it('closes the run as soon as the lease is lost even when the handler ignores the signal', async () => {
    const registry = new JobRegistry();
    const finished = deferred();
    registry.register('RECONCILIATION', async () => {
      await sleep(2_500);
      finished.resolve();
      return { summary: { late: true } };
    });
    const a = runner('replica-a', registry, 2);
    const t0 = Date.now();
    const pending = a.run('RECONCILIATION', 'test');
    await waitFor(() => leaseOf('RECONCILIATION'));
    await ctx.prisma.jobLease.delete({ where: { jobName: 'RECONCILIATION' } });
    const run = await pending;
    expect(Date.now() - t0).toBeLessThan(2_200);
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain(LEASE_LOST);
    // The late result of the handler does not overwrite the verdict.
    await finished.promise;
    await sleep(100);
    const after = await ctx.prisma.maintenanceRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('FAILED');
    expect(after.summary).toBeNull();
  });

  it('lets only the owner renew or release a lease', async () => {
    const a = new JobLeaseStore(ctx.prisma, 'replica-a', 30);
    const b = new JobLeaseStore(ctx.prisma, 'replica-b', 30);
    const runId = randomUUID();
    expect(await a.acquire('EXPIRE_STALE', runId)).toEqual({ takenOver: null });
    expect(await b.acquire('EXPIRE_STALE', randomUUID())).toBeNull();
    expect(await b.release('EXPIRE_STALE')).toBe(false);
    expect(await b.renew('EXPIRE_STALE', runId)).toBe(false);
    expect(await a.release('EXPIRE_STALE', randomUUID())).toBe(false); // not this run
    expect((await leaseOf('EXPIRE_STALE'))?.ownerId).toBe('replica-a');
    expect(await a.renew('EXPIRE_STALE', runId)).toBe(true);
    const lease = await a.get('EXPIRE_STALE');
    expect(lease).toMatchObject({ ownerId: 'replica-a', runId, expired: false });
    expect(lease!.expiresAt.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(await a.release('EXPIRE_STALE', runId)).toBe(true);
    expect(await leaseOf('EXPIRE_STALE')).toBeNull();
    // Expired lease: taken over, and the previous holder is reported.
    await ctx.prisma.jobLease.create({
      data: { jobName: 'EXPIRE_STALE', ownerId: 'gone', runId, expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await b.acquire('EXPIRE_STALE', randomUUID())).toEqual({ takenOver: { ownerId: 'gone', runId } });
  });
});

describe('admin jobs console: driver, instance and leases', () => {
  it('returns the driver, the instance id and the current leases', async () => {
    const { client: plain } = await registerUser(ctx, 'plain@example.com');
    const { client: admin } = await registerUser(ctx, 'admin@example.com');
    await promote(ctx, 'admin@example.com', 'ADMIN');
    expect((await plain.get('/v1/admin/jobs')).status).toBe(403);

    const replica = new JobLeaseStore(ctx.prisma, 'replica-a', 60);
    const runId = randomUUID();
    await replica.acquire('RECONCILIATION', runId);
    await ctx.prisma.jobLease.create({
      data: { jobName: 'EXPIRE_STALE', ownerId: 'gone', expiresAt: new Date(Date.now() - 5_000) },
    });

    const res = await admin.get('/v1/admin/jobs');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      sandbox: true,
      schedulerEnabled: false,
      driver: 'inprocess',
      instanceId: baseEnv.INSTANCE_ID,
      leaseSeconds: baseEnv.JOB_LEASE_SECONDS,
      scheduler: { driver: 'inprocess', enabled: false, started: false, queue: null },
    });
    const leases = res.body.leases as any[];
    expect(leases.map((l) => l.jobName).sort()).toEqual(['EXPIRE_STALE', 'RECONCILIATION']);
    const live = leases.find((l) => l.jobName === 'RECONCILIATION');
    expect(live).toMatchObject({ ownerId: 'replica-a', runId, expired: false });
    expect(typeof live.acquiredAt).toBe('string');
    expect(typeof live.heartbeatAt).toBe('string');
    expect(new Date(live.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(leases.find((l) => l.jobName === 'EXPIRE_STALE')).toMatchObject({
      ownerId: 'gone',
      expired: true,
    });
    const job = res.body.jobs.find((j: any) => j.name === 'RECONCILIATION');
    expect(job.lease.ownerId).toBe('replica-a');
    expect(job.nextRunAt).toBeNull();
    expect(res.body.jobs.find((j: any) => j.name === 'BALANCE_SNAPSHOTS').lease).toBeNull();

    // Runs record the instance that executed them.
    const run = await admin.post('/v1/admin/jobs/BALANCE_SNAPSHOTS/run');
    expect(run.status).toBe(200);
    expect(run.body.instanceId).toBe(baseEnv.INSTANCE_ID);
    // A manual trigger on a job leased elsewhere is refused.
    const busy = await admin.post('/v1/admin/jobs/RECONCILIATION/run');
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('JOB_ALREADY_RUNNING');
  });
});

describe('WEBHOOK_RETRY sweep of stale PENDING deliveries', () => {
  let server: Server;
  let port = 0;
  const received: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({ path: req.url ?? '/', headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('attempts deliveries left PENDING for more than 5 minutes, and only those', async () => {
    const { client: owner } = await registerUser(ctx, 'dev@example.com');
    const created = await owner.post('/v1/webhooks', {
      url: `http://127.0.0.1:${port}/hook`,
      events: ['transaction.created'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const subscriptionId = created.body.webhook.id as string;
    received.length = 0;

    const delivery = (createdAt: Date) => {
      const eventId = randomUUID();
      return ctx.prisma.webhookDelivery.create({
        data: {
          subscriptionId,
          eventType: 'transaction.created',
          eventId,
          payload: {
            id: eventId,
            type: 'transaction.created',
            createdAt: createdAt.toISOString(),
            sandbox: true,
            data: { entityType: 'Transaction', entityId: randomUUID() },
          },
          signature: '',
          status: 'PENDING',
          createdAt,
        },
      });
    };
    // Crash between the insert and the first POST, 6 minutes ago → must be attempted.
    const stale = await delivery(new Date(Date.now() - STALE_PENDING_AFTER_MS - 60_000));
    // Created a minute ago (its first attempt may still be in flight) → left alone.
    const recent = await delivery(new Date(Date.now() - 60_000));

    const run = await ctx.app.get(MaintenanceService).run('WEBHOOK_RETRY', 'test');
    expect(run.status, run.error ?? '').toBe('COMPLETED');
    expect(run.summary).toMatchObject({ due: 0, stalePending: 1, attempted: 1, delivered: 1 });

    const swept = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: stale.id } });
    expect(swept).toMatchObject({ status: 'DELIVERED', attempts: 1, lastStatusCode: 200 });
    expect(swept.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const untouched = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: recent.id } });
    expect(untouched).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers['x-dfn-delivery']).toBe(stale.id);

    const again = await ctx.app.get(MaintenanceService).run('WEBHOOK_RETRY', 'test');
    expect(again.summary).toMatchObject({ stalePending: 0, attempted: 0 });
    expect(received).toHaveLength(1);
  });

  it('claims a delivery before sending it: concurrent attempts send it once, expired claims are retried', async () => {
    const { client: owner } = await registerUser(ctx, 'dev-claim@example.com');
    const created = await owner.post('/v1/webhooks', {
      url: `http://127.0.0.1:${port}/hook`,
      events: ['transaction.created'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const subscriptionId = created.body.webhook.id as string;
    received.length = 0;
    const delivery = (createdAt: Date, nextAttemptAt: Date | null = null) => {
      const eventId = randomUUID();
      return ctx.prisma.webhookDelivery.create({
        data: {
          subscriptionId,
          eventType: 'transaction.created',
          eventId,
          payload: {
            id: eventId,
            type: 'transaction.created',
            createdAt: createdAt.toISOString(),
            sandbox: true,
            data: {},
          },
          signature: '',
          status: 'PENDING',
          createdAt,
          nextAttemptAt,
        },
      });
    };
    const dispatcher = ctx.app.get(WebhookDispatcherService);

    // Three workers race on the same row: exactly one POST, one attempt recorded.
    const raced = await delivery(new Date(Date.now() - STALE_PENDING_AFTER_MS - 60_000));
    await Promise.all([
      dispatcher.deliver(raced.id, 'retry'),
      dispatcher.deliver(raced.id, 'manual'),
      dispatcher.deliver(raced.id, 'retry'),
    ]);
    expect(received.filter((r) => r.headers['x-dfn-delivery'] === raced.id)).toHaveLength(1);
    expect(await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: raced.id } })).toMatchObject({
      status: 'DELIVERED',
      attempts: 1,
    });

    // A claim that expired (the attempt died in flight) is retried; a live claim is left alone.
    received.length = 0;
    const died = await delivery(new Date(Date.now() - 60_000), new Date(Date.now() - 1_000));
    const inFlight = await delivery(
      new Date(Date.now() - STALE_PENDING_AFTER_MS - 60_000),
      new Date(Date.now() + 60_000),
    );
    const run = await ctx.app.get(MaintenanceService).run('WEBHOOK_RETRY', 'test');
    expect(run.summary).toMatchObject({ stalePending: 1, attempted: 1, delivered: 1 });
    expect(received.map((r) => r.headers['x-dfn-delivery'])).toEqual([died.id]);
    expect(await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: inFlight.id } })).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
  });
});

describe('Redis rate-limit stores', () => {
  let redisA: Redis;
  let redisB: Redis;

  beforeAll(async () => {
    if (!redisAvailable) return;
    redisA = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    redisB = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    await redisA.flushdb();
  });
  afterAll(async () => {
    if (!redisAvailable) return;
    await redisA.flushdb();
    await redisA.quit();
    await redisB.quit();
  });

  it('shares one sliding window between two limiter instances (two replicas)', async (context) => {
    requireRedis(context);
    const a = new RedisRateLimitStore({ client: () => redisA });
    const b = new RedisRateLimitStore({ client: () => redisB });
    const key = `test:${randomUUID()}`;
    expect(await a.hit(key, 3, 60_000)).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      retryAfterSeconds: 0,
    });
    expect((await b.hit(key, 3, 60_000)).remaining).toBe(1);
    expect((await a.hit(key, 3, 60_000)).remaining).toBe(0);
    const refused = await b.hit(key, 3, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect((await a.hit(key, 3, 60_000)).allowed).toBe(false);
    // Other keys are independent; every key carries a TTL and the dfn:rl: namespace.
    expect((await b.hit(`test:${randomUUID()}`, 3, 60_000)).allowed).toBe(true);
    const ttl = await redisA.pttl(`dfn:rl:sw:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    await a.reset(key);
    expect((await b.hit(key, 3, 60_000)).allowed).toBe(true);
  });

  it('frees slots when the window slides past them', async (context) => {
    requireRedis(context);
    const store = new RedisRateLimitStore({ client: () => redisA });
    const key = `test:${randomUUID()}`;
    expect((await store.hit(key, 2, 400)).allowed).toBe(true);
    expect((await store.hit(key, 2, 400)).allowed).toBe(true);
    const refused = await store.hit(key, 2, 400);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 });
    await sleep(450);
    expect((await store.hit(key, 2, 400)).allowed).toBe(true);
    await sleep(450);
    expect(await redisA.exists(`dfn:rl:sw:${key}`)).toBe(0); // expired with its TTL
  });

  it('grants a claim once per interval across instances (lastUsedAt throttle)', async (context) => {
    requireRedis(context);
    const a = new RedisRateLimitStore({ client: () => redisA });
    const b = new RedisRateLimitStore({ client: () => redisB });
    const key = `lastused:${randomUUID()}`;
    expect(await a.claim(key, 300)).toBe(true);
    expect(await b.claim(key, 300)).toBe(false);
    expect(await a.claim(key, 300)).toBe(false);
    expect(await redisA.pttl(`dfn:rl:once:${key}`)).toBeGreaterThan(0);
    await sleep(350);
    expect(await b.claim(key, 300)).toBe(true);
  });

  it('degrades to per-replica memory limits when Redis is unavailable', async () => {
    const broken = new RedisRateLimitStore({
      client: () => {
        throw new Error('connection refused');
      },
    });
    const key = `test:${randomUUID()}`;
    expect((await broken.hit(key, 1, 60_000)).allowed).toBe(true);
    expect((await broken.hit(key, 1, 60_000)).allowed).toBe(false);
    expect(await broken.claim(key, 60_000)).toBe(true);
    expect(await broken.claim(key, 60_000)).toBe(false);
  });

  it('shares the @nestjs/throttler counters between instances and blocks above the limit', async (context) => {
    requireRedis(context);
    const a = new RedisThrottlerStorage({ client: () => redisA });
    const b = new RedisThrottlerStorage({ client: () => redisB });
    const key = `ip-${randomUUID()}`;
    expect(await a.increment(key, 1_000, 2, 1_000, 'default')).toMatchObject({
      totalHits: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(await b.increment(key, 1_000, 2, 1_000, 'default')).toMatchObject({
      totalHits: 2,
      isBlocked: false,
    });
    const blocked = await a.increment(key, 1_000, 2, 1_000, 'default');
    expect(blocked).toMatchObject({ isBlocked: true, timeToBlockExpire: 1 });
    expect((await b.increment(key, 1_000, 2, 1_000, 'default')).isBlocked).toBe(true);
    expect((await a.increment(key, 1_000, 2, 1_000, 'other')).isBlocked).toBe(false); // per throttler
    await sleep(1_100);
    expect(await b.increment(key, 1_000, 2, 1_000, 'default')).toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    a.onApplicationShutdown();
    b.onApplicationShutdown();
  });
});

interface Instance {
  ctx: TestContext;
  scheduler: JobsSchedulerService;
  registry: JobRegistry;
}

async function bootInstance(instanceId: string): Promise<Instance> {
  const { app } = await createApp({
    JOBS_DRIVER: 'bullmq',
    RATE_LIMIT_STORE: 'redis',
    REDIS_URL,
    INSTANCE_ID: instanceId,
  });
  await app.init();
  const instanceCtx: TestContext = {
    app: app as INestApplication,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
  return { ctx: instanceCtx, scheduler: app.get(JobsSchedulerService), registry: app.get(JobRegistry) };
}

describe('BullMQ driver and Redis stores across two API instances', () => {
  let a: Instance;
  let b: Instance;
  let admin: Redis;
  let queueConnection: Redis;
  let queue: Queue;

  beforeAll(async () => {
    if (!redisAvailable) return;
    admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    await admin.flushdb();
    a = await bootInstance('bull-a');
    b = await bootInstance('bull-b');
    // Both replicas start their scheduler at the same time (NODE_ENV=test does not auto-start it).
    await Promise.all([a.scheduler.start(), b.scheduler.start()]);
    queueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(MAINTENANCE_QUEUE, { connection: queueConnection });
  });
  afterAll(async () => {
    await queue?.close();
    await queueConnection?.quit();
    await a?.ctx.close();
    await b?.ctx.close();
    if (!admin) return;
    await admin.flushdb();
    await admin.quit();
  });

  it('registers one repeatable schedule per job, even with two instances', async (context) => {
    requireRedis(context);
    const names = a.registry.list();
    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(await queue.getJobSchedulersCount()).toBe(names.length);
    const schedules = await a.scheduler.schedules();
    expect(schedules.map((s) => s.key).sort()).toEqual(names.map(schedulerIdFor).sort());
    const every = baseEnv.JOBS_INTERVAL_MINUTES * 60_000;
    for (const schedule of schedules) {
      expect(Number(schedule.every)).toBe(every);
      // First execution one interval after creation, like the in-process timer.
      expect(Number(schedule.next)).toBeGreaterThan(Date.now() + every - 60_000);
    }
    // A replica restarting (upsert again) does not duplicate anything.
    const third = await bootInstance('bull-c');
    try {
      await third.scheduler.start();
      expect(await queue.getJobSchedulersCount()).toBe(names.length);
    } finally {
      await third.ctx.close();
    }
    const status = await b.scheduler.status();
    expect(status).toMatchObject({ driver: 'bullmq', started: true, queue: MAINTENANCE_QUEUE });
    expect(Object.keys(status.nextRuns).sort()).toEqual([...names].sort());
  });

  it('runs a queued job once, through the lease runner, on one of the replicas', async (context) => {
    requireRedis(context);
    const jobId = await a.scheduler.enqueue('BALANCE_SNAPSHOTS');
    const job = await waitFor(async () => {
      const j = await queue.getJob(jobId);
      return j?.finishedOn ? j : null;
    }, 10_000);
    expect(job.returnvalue).toMatchObject({ jobName: 'BALANCE_SNAPSHOTS', status: 'COMPLETED' });
    const runs = await ctx.prisma.maintenanceRun.findMany({ where: { jobName: 'BALANCE_SNAPSHOTS' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'COMPLETED',
      triggeredBy: BULLMQ_TRIGGER,
      id: job.returnvalue.runId,
    });
    expect(['bull-a', 'bull-b']).toContain(runs[0]!.instanceId);
    expect(await ctx.prisma.jobLease.count()).toBe(0);

    // A job whose lease is held elsewhere is skipped (no retry, no second run).
    const elsewhere = new JobLeaseStore(ctx.prisma, 'replica-elsewhere', 60);
    await elsewhere.acquire('RECONCILIATION', randomUUID());
    const skippedId = await b.scheduler.enqueue('RECONCILIATION');
    const skipped = await waitFor(async () => {
      const j = await queue.getJob(skippedId);
      return j?.finishedOn ? j : null;
    }, 10_000);
    expect(skipped.returnvalue).toMatchObject({ jobName: 'RECONCILIATION', skipped: 'already_running' });
    expect(skipped.attemptsMade).toBeLessThanOrEqual(1);
    expect(await ctx.prisma.maintenanceRun.count({ where: { jobName: 'RECONCILIATION' } })).toBe(0);
  });

  it('applies API-key quotas across replicas and throttles lastUsedAt writes with Redis', async (context) => {
    requireRedis(context);
    const { client: owner } = await registerUser(a.ctx, 'dev@example.com');
    const created = await owner.post('/v1/api-credentials', {
      name: 'Clé partagée',
      scopes: ['transactions:read'],
      rateLimitPerMinute: 10,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const key = created.body.key as string;
    const credentialId = created.body.credential.id as string;
    const call = (instance: Instance) =>
      instance.ctx.http().get('/v1/transactions').set('Authorization', `Bearer ${key}`);

    for (let i = 0; i < 10; i++) {
      const res = await call(i % 2 === 0 ? a : b);
      expect(res.status, `call ${i + 1}`).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe(String(9 - i));
    }
    const refusedOnB = await call(b);
    expect(refusedOnB.status).toBe(429);
    expect(refusedOnB.body.code).toBe('RATE_LIMITED');
    expect(Number(refusedOnB.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call(a)).status).toBe(429);
    expect(await admin.pttl(`dfn:rl:sw:apikey:${credentialId}`)).toBeGreaterThan(0);

    // lastUsedAt: written once, then at most once per minute whatever the replica.
    const stamped = await waitFor(async () => {
      const row = await a.ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: credentialId } });
      return row.lastUsedAt;
    });
    expect(stamped).toBeInstanceOf(Date);
    expect(await admin.pttl(`dfn:rl:once:lastused:${credentialId}`)).toBeGreaterThan(50_000);
    await a.ctx.prisma.apiCredential.update({ where: { id: credentialId }, data: { lastUsedAt: null } });
    const apiAuthB = b.ctx.app.get(ApiAuthService);
    expect(apiAuthB.rateLimitStore.kind).toBe('redis');
    // The global per-IP throttler uses the Redis storage too (RATE_LIMIT_STORE=redis).
    expect(b.ctx.app.get(getStorageToken())).toBeInstanceOf(RedisThrottlerStorage);
    expect(await apiAuthB.touchLastUsed(credentialId)).toBe(false);
    expect(await a.ctx.app.get(ApiAuthService).touchLastUsed(credentialId)).toBe(false);
    expect(
      (await a.ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: credentialId } })).lastUsedAt,
    ).toBeNull();
    // Once the minute has elapsed (claim expired), the next request writes it again.
    await admin.del(`dfn:rl:once:lastused:${credentialId}`);
    expect(await apiAuthB.touchLastUsed(credentialId)).toBe(true);
    expect(
      (await a.ctx.prisma.apiCredential.findUniqueOrThrow({ where: { id: credentialId } })).lastUsedAt,
    ).not.toBeNull();

    // Revoking the key clears its shared counters.
    expect((await owner.delete(`/v1/api-credentials/${credentialId}`)).status).toBe(200);
    await waitFor(async () => (await admin.exists(`dfn:rl:sw:apikey:${credentialId}`)) === 0);
  });
});
