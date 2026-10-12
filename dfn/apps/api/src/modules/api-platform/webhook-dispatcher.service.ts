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
import { postWebhook } from './webhook-http';

/** Consecutive failures after which a subscription is switched off automatically. */
export const AUTO_DISABLE_AFTER_FAILURES = 50;
/** Max deliveries attempted by one WEBHOOK_RETRY run (bounded run time; the rest waits for the next run). */
const RETRY_BATCH = 200;
/** Share of a run's budget reserved for stale PENDING deliveries (never attempted). */
const STALE_PENDING_BATCH = 100;
/**
 * A delivery still PENDING and unclaimed this long after its creation was never attempted (the
 * process crashed or restarted between the insert and the first POST): WEBHOOK_RETRY attempts it.
 */
export const STALE_PENDING_AFTER_MS = 5 * 60_000;
/**
 * Every attempt first claims its row: a fresh `claimToken` and `claimedUntil` = now + this delay,
 * set only when no live claim exists, so two workers never send the same delivery at the same time
 * (whatever state they read it in). The back-off schedule (`nextAttemptAt`) is left untouched. A
 * claim older than this belongs to an attempt that died in flight (crash, lost result write): the
 * row is attempted again — delivery is at-least-once and receivers deduplicate on `X-DFN-Delivery`.
 * Far above WEBHOOK_TIMEOUT_MS (≤ 30 s).
 */
export const DELIVERY_CLAIM_MS = 5 * 60_000;

export type DeliverySource = 'event' | 'retry' | 'manual' | 'test';

export interface DeliveryAttempt {
  /** The row after the attempt, or as found when it was not attempted. */
  delivery: WebhookDelivery;
  /** false when the row could not be claimed (being sent by another attempt, final or not due): nothing was sent. */
  attempted: boolean;
}

/** No live claim on the row: never claimed, released by the last attempt, or expired. */
function claimFree(now: Date): Prisma.WebhookDeliveryWhereInput {
  return { OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] };
}

/** Rows an attempt from `source` may send (checked atomically with the claim). */
function sendableBy(source: DeliverySource, now: Date): Prisma.WebhookDeliveryWhereInput {
  switch (source) {
    case 'event':
    case 'test':
      // first attempt, right after the row was created
      return { status: 'PENDING' };
    case 'retry':
      // never attempted (stale sweep), or failed and due — not one retried since it was listed
      return { OR: [{ status: 'PENDING' }, { status: 'FAILED', nextAttemptAt: { lte: now } }] };
    case 'manual':
      // regardless of the back-off schedule
      return { status: { in: ['FAILED', 'EXHAUSTED'] } };
  }
}

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
   * Performs one attempt for a delivery and persists the outcome. Returns the updated row (as found
   * when it was not attempted, see attempt()). `source` decides which rows may be sent.
   */
  async deliver(deliveryId: string, source: DeliverySource): Promise<WebhookDelivery> {
    return (await this.attempt(deliveryId, source)).delivery;
  }

  /**
   * One attempt for a delivery. The row is claimed first — atomically, only if no live claim exists
   * and it is still sendable by `source` — so that a concurrent reader (retry job on another
   * instance, stale sweep, manual retry) never sends it a second time while this attempt is in
   * flight, whatever state it read the row in. Only the holder of the claim token writes the
   * outcome and releases the claim: an attempt whose claim expired and was taken over writes nothing.
   */
  async attempt(deliveryId: string, source: DeliverySource): Promise<DeliveryAttempt> {
    const claimedAt = new Date();
    const claimToken = randomUUID();
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, AND: [claimFree(claimedAt), sendableBy(source, claimedAt)] },
      data: { claimedUntil: new Date(claimedAt.getTime() + DELIVERY_CLAIM_MS), claimToken },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
      if (!current) throw new Error(`webhook delivery ${deliveryId} not found`);
      this.logger.debug(
        `delivery ${deliveryId} (${source}) not attempted: ${current.status}, being sent by another attempt or not due`,
      );
      return { delivery: current, attempted: false };
    }
    // Read under the claim: no other attempt writes this row until the claim is released or expires.
    const delivery = await this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { subscription: true },
    });
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
      // The socket's own DNS lookup re-checks every address (DNS rebinding between the check
      // above and the connection is refused); redirects are never followed.
      statusCode = await postWebhook(
        subscription.url,
        {
          'Content-Type': 'application/json',
          'User-Agent': 'DFN-Webhooks/1.0 (sandbox)',
          'X-DFN-Event': delivery.eventType,
          'X-DFN-Delivery': delivery.id,
          'X-DFN-Signature': signature,
          'X-DFN-Mode': 'sandbox',
        },
        rawBody,
        this.env.WEBHOOK_TIMEOUT_MS,
        this.env.NODE_ENV !== 'test',
      );
      if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
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
    let deactivated = false;
    const updated = await this.prisma.$transaction(async (tx) => {
      // Written only while this attempt still holds the claim, which the write releases.
      const written = await tx.webhookDelivery.updateMany({
        where: { id: delivery.id, claimToken },
        data: {
          attempts,
          signature,
          lastStatusCode: statusCode,
          lastError: error ? error.slice(0, 500) : null,
          status: delivered ? 'DELIVERED' : exhausted ? 'EXHAUSTED' : 'FAILED',
          deliveredAt: delivered ? now : null,
          nextAttemptAt:
            delivered || exhausted ? null : new Date(now.getTime() + nextAttemptDelayMs(attempts)),
          claimedUntil: null,
          claimToken: null,
        },
      });
      if (written.count !== 1) return null;
      if (delivered) {
        await tx.webhookSubscription.update({
          where: { id: subscription.id },
          data: { failureCount: 0, lastDeliveryAt: now },
        });
      } else {
        // Incremented in place: concurrent attempts on other deliveries of the subscription all count.
        await tx.webhookSubscription.update({
          where: { id: subscription.id },
          data: { failureCount: { increment: 1 }, lastDeliveryAt: now },
        });
        const disabled = await tx.webhookSubscription.updateMany({
          where: {
            id: subscription.id,
            isActive: true,
            failureCount: { gte: AUTO_DISABLE_AFTER_FAILURES },
          },
          data: { isActive: false },
        });
        deactivated = disabled.count === 1;
      }
      return tx.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    });
    if (!updated) {
      // The claim expired during the attempt and another attempt took the row over: its outcome
      // stands (the receiver may have seen both requests — at-least-once, same X-DFN-Delivery).
      this.logger.warn(
        `delivery ${delivery.id} (${source}): claim lost before the outcome was written, result discarded`,
      );
      return {
        delivery: await this.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
        attempted: true,
      };
    }
    this.logger.debug(
      `delivery ${delivery.id} (${source}) → ${updated.status} status=${statusCode ?? 'n/a'} attempt=${attempts}`,
    );
    if (deactivated) {
      this.logger.warn(
        `webhook subscription ${subscription.id} deactivated after ${AUTO_DISABLE_AFTER_FAILURES} consecutive failures`,
      );
    }
    return { delivery: updated, attempted: true };
  }

  /**
   * WEBHOOK_RETRY job: attempts the deliveries stuck in PENDING for more than 5 minutes (never
   * attempted: crash between creation and first POST), replays the due FAILED ones, and purges
   * expired idempotency records. Rows being sent (live claim) are left alone; a row claimed by
   * another attempt between the listing and its turn is skipped. Batch-bounded; stops between
   * deliveries when `signal` aborts (job lease lost) — whatever is left is picked up by the next run.
   */
  async retryDue(now = new Date(), signal?: AbortSignal): Promise<JobResult> {
    const activeSubscription = { isActive: true, revokedAt: null };
    const stalePending = await this.prisma.webhookDelivery.findMany({
      where: {
        status: 'PENDING',
        attempts: 0,
        subscription: activeSubscription,
        OR: [
          // never claimed: crash between the insert and the first attempt
          { claimedUntil: null, createdAt: { lte: new Date(now.getTime() - STALE_PENDING_AFTER_MS) } },
          // claimed, but the claim expired: the first attempt died in flight
          { claimedUntil: { lt: now } },
        ],
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
        ...claimFree(now),
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: RETRY_BATCH - stalePending.length,
      select: { id: true },
    });
    let delivered = 0;
    let failed = 0;
    let exhausted = 0;
    let attempted = 0;
    let skipped = 0;
    for (const { id } of [...stalePending, ...due]) {
      if (signal?.aborted) break;
      try {
        const result = await this.attempt(id, 'retry');
        if (!result.attempted) {
          skipped++;
          continue;
        }
        attempted++;
        if (result.delivery.status === 'DELIVERED') delivered++;
        else if (result.delivery.status === 'EXHAUSTED') exhausted++;
        else failed++;
      } catch (err) {
        attempted++;
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
        skipped,
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
