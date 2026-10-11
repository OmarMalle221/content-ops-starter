import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type WebhookDelivery, type WebhookSubscription } from '@dfn/database';
import { signPayload } from '@dfn/payment-adapters';
import { ALL_WEBHOOK_EVENTS, KeyPurpose } from '@dfn/shared';
import { openString } from '../../common/keyring';
import { DomainEventsBus, type DomainEvent } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { JobRegistry, type JobResult } from '../jobs/job-registry';
import { unsafeDestinationReason } from './ssrf';

/** Consecutive failures after which a subscription is switched off automatically. */
export const AUTO_DISABLE_AFTER_FAILURES = 50;
/** Max deliveries attempted by one WEBHOOK_RETRY run (bounded run time; the rest waits for the next run). */
const RETRY_BATCH = 200;
/** Share of a run's budget reserved for stale PENDING deliveries (never attempted). */
const STALE_PENDING_BATCH = 100;
/**
 * A delivery still PENDING this long after its creation was never attempted (the process crashed
 * or restarted between the insert and the first POST): WEBHOOK_RETRY attempts it. Far above the
 * longest in-flight first attempt (WEBHOOK_TIMEOUT_MS ≤ 30 s), so a live attempt is never doubled.
 */
export const STALE_PENDING_AFTER_MS = 5 * 60_000;

export interface WebhookEnvelope {
  id: string;
  type: string;
  createdAt: string;
  sandbox: true;
  data: Record<string, unknown>;
}

export function buildEnvelope(
  eventId: string,
  type: string,
  createdAt: Date,
  data: Record<string, unknown>,
): WebhookEnvelope {
  return { id: eventId, type, createdAt: createdAt.toISOString(), sandbox: true, data };
}

/** Exponential back-off: 2^attempts minutes after the attempt that just failed. */
export function nextAttemptDelayMs(attempts: number): number {
  return 2 ** Math.min(attempts, 20) * 60_000;
}

/** `t=<unix seconds>,v1=<hex hmac>` — the header a partner verifies with verifySignature(). */
export function signatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, String(timestampSeconds), rawBody)}`;
}

/**
 * Routes domain events to partner webhooks: creates one WebhookDelivery per active subscription,
 * posts it immediately with an HMAC signature, and schedules retries with exponential back-off.
 * The WEBHOOK_RETRY maintenance job replays due deliveries and purges expired idempotency records.
 *
 * Secrets and payload bodies are never logged (debug level logs only ids and status codes).
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly subscribed = new Set(ALL_WEBHOOK_EVENTS as string[]);
  private unsubscribe?: () => void;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventsBus,
    private readonly registry: JobRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.bus.on((event) => this.onEvent(event));
    this.registry.register('WEBHOOK_RETRY', (ctx) => this.retryDue(new Date(), ctx.signal));
  }

  async onModuleDestroy() {
    this.unsubscribe?.();
    // Let deliveries started by the last events settle so that tests and shutdowns observe them.
    await Promise.allSettled([...this.inFlight]);
  }

  /** Bus handler: fan out one delivery per matching subscription and deliver right away. */
  async onEvent(event: DomainEvent): Promise<void> {
    if (!this.subscribed.has(event.type) || event.organizationIds.length === 0) return;
    const subscriptions = await this.prisma.webhookSubscription.findMany({
      where: {
        organizationId: { in: event.organizationIds },
        isActive: true,
        revokedAt: null,
        events: { has: event.type },
      },
      select: { id: true },
    });
    if (subscriptions.length === 0) return;
    const eventId = randomUUID();
    const envelope = buildEnvelope(eventId, event.type, event.occurredAt, {
      entityType: event.entityType,
      entityId: event.entityId,
      ...event.payload,
    });
    for (const sub of subscriptions) {
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          eventType: event.type,
          eventId,
          payload: envelope as unknown as Prisma.InputJsonObject,
          signature: '',
          status: 'PENDING',
        },
      });
      this.track(this.deliver(delivery.id, 'event'));
    }
  }

  /** Synthetic event for the "send test" button: delivered synchronously, result returned. */
  async sendTest(
    subscription: WebhookSubscription,
    eventType: string,
    actorUserId: string,
  ): Promise<WebhookDelivery> {
    const eventId = randomUUID();
    const envelope = buildEnvelope(eventId, eventType, new Date(), {
      test: true,
      message: 'Événement de test — Données fictives — Aucun fonds réel.',
      subscriptionId: subscription.id,
      organizationId: subscription.organizationId,
      triggeredByUserId: actorUserId,
    });
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        subscriptionId: subscription.id,
        eventType,
        eventId,
        payload: envelope as unknown as Prisma.InputJsonObject,
        signature: '',
        status: 'PENDING',
      },
    });
    return this.deliver(delivery.id, 'test');
  }

  /**
   * Performs one attempt for a delivery and persists the outcome. Returns the updated row.
   * `source` only feeds debug logs.
   */
  async deliver(deliveryId: string, source: 'event' | 'retry' | 'manual' | 'test'): Promise<WebhookDelivery> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { subscription: true },
    });
    if (!delivery) throw new Error(`webhook delivery ${deliveryId} not found`);
    const { subscription } = delivery;
    const rawBody = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let signature = '';
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      // Dispatch-time SSRF guard: the hostname is resolved now, so a DNS name that points (or was
      // re-pointed) to a private address is refused even if it passed the lexical check at creation.
      // Egress allowlist (WEBHOOK_ALLOWED_HOSTS) is enforced at dispatch time too, not only when the
      // subscription is created, so tightening the list takes effect on existing subscriptions.
      const unsafe = await unsafeDestinationReason(
        subscription.url,
        this.env.NODE_ENV,
        this.env.WEBHOOK_ALLOWED_HOSTS,
      );
      if (unsafe) throw new Error(`Destination refused: ${unsafe}`);
      const secret = openString(this.env, KeyPurpose.WEBHOOKS, subscription.secretEnc);
      signature = signatureHeader(secret, timestamp, rawBody);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.env.WEBHOOK_TIMEOUT_MS);
      try {
        const response = await fetch(subscription.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'DFN-Webhooks/1.0 (sandbox)',
            'X-DFN-Event': delivery.eventType,
            'X-DFN-Delivery': delivery.id,
            'X-DFN-Signature': signature,
            'X-DFN-Mode': 'sandbox',
          },
          body: rawBody,
          redirect: 'manual',
          signal: controller.signal,
        });
        statusCode = response.status;
        if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
        // Drain the body so that the socket is released; the content is irrelevant.
        await response.arrayBuffer().catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error =
        err instanceof Error && err.name === 'AbortError'
          ? `Timeout after ${this.env.WEBHOOK_TIMEOUT_MS} ms`
          : err instanceof Error
            ? err.message
            : String(err);
    }
    const attempts = delivery.attempts + 1;
    const now = new Date();
    const delivered = error === null;
    const exhausted = !delivered && attempts >= this.env.WEBHOOK_MAX_ATTEMPTS;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          signature,
          lastStatusCode: statusCode,
          lastError: error ? error.slice(0, 500) : null,
          status: delivered ? 'DELIVERED' : exhausted ? 'EXHAUSTED' : 'FAILED',
          deliveredAt: delivered ? now : null,
          nextAttemptAt:
            delivered || exhausted ? null : new Date(now.getTime() + nextAttemptDelayMs(attempts)),
        },
      });
      if (delivered) {
        await tx.webhookSubscription.update({
          where: { id: subscription.id },
          data: { failureCount: 0, lastDeliveryAt: now },
        });
      } else {
        const failureCount = subscription.failureCount + 1;
        await tx.webhookSubscription.update({
          where: { id: subscription.id },
          data: {
            failureCount,
            lastDeliveryAt: now,
            ...(failureCount >= AUTO_DISABLE_AFTER_FAILURES && subscription.isActive
              ? { isActive: false }
              : {}),
          },
        });
      }
      return row;
    });
    this.logger.debug(
      `delivery ${delivery.id} (${source}) → ${updated.status} status=${statusCode ?? 'n/a'} attempt=${attempts}`,
    );
    if (!delivered && subscription.failureCount + 1 === AUTO_DISABLE_AFTER_FAILURES) {
      this.logger.warn(
        `webhook subscription ${subscription.id} deactivated after ${AUTO_DISABLE_AFTER_FAILURES} consecutive failures`,
      );
    }
    return updated;
  }

  /**
   * WEBHOOK_RETRY job: attempts the deliveries stuck in PENDING for more than 5 minutes (never
   * attempted: crash between creation and first POST), replays the due FAILED ones, and purges
   * expired idempotency records. Batch-bounded; stops between deliveries when `signal` aborts
   * (job lease lost) — whatever is left is picked up by the next run.
   */
  async retryDue(now = new Date(), signal?: AbortSignal): Promise<JobResult> {
    const activeSubscription = { isActive: true, revokedAt: null };
    const stalePending = await this.prisma.webhookDelivery.findMany({
      where: {
        status: 'PENDING',
        attempts: 0,
        createdAt: { lte: new Date(now.getTime() - STALE_PENDING_AFTER_MS) },
        subscription: activeSubscription,
      },
      orderBy: { createdAt: 'asc' },
      take: STALE_PENDING_BATCH,
      select: { id: true },
    });
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: 'FAILED',
        nextAttemptAt: { lte: now },
        subscription: activeSubscription,
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: RETRY_BATCH - stalePending.length,
      select: { id: true },
    });
    let delivered = 0;
    let failed = 0;
    let exhausted = 0;
    let attempted = 0;
    for (const { id } of [...stalePending, ...due]) {
      if (signal?.aborted) break;
      attempted++;
      try {
        const result = await this.deliver(id, 'retry');
        if (result.status === 'DELIVERED') delivered++;
        else if (result.status === 'EXHAUSTED') exhausted++;
        else failed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `retry of delivery ${id} crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    signal?.throwIfAborted();
    const purged = await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
    return {
      summary: {
        due: due.length,
        stalePending: stalePending.length,
        attempted,
        delivered,
        failed,
        exhausted,
        idempotencyRecordsPurged: purged.count,
      },
    };
  }

  private track(promise: Promise<unknown>) {
    const tracked = promise
      .catch((err) =>
        this.logger.error(`delivery failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
}
