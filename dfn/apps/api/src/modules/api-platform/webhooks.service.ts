import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { WebhookSubscription } from '@dfn/database';
import {
  Permission,
  type CreateWebhookRequest,
  type ListWebhooksQuery,
  type SendTestWebhookInput,
  type UpdateWebhookInput,
  type WebhookDeliveriesQuery,
  KeyPurpose,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { randomToken } from '../../common/crypto';
import { sealString } from '../../common/keyring';
import { DomainError } from '../../common/domain-error';
import { paginate } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { toWebhookDeliveryDto, toWebhookDto } from './api-platform.dto';
import { assertSafeWebhookUrl } from './ssrf';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/** Signing secrets are 32 random bytes, base64url, prefixed so that leaks are recognisable. */
export function generateWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}

/**
 * Webhook subscriptions of an organisation. Managed from the console (API_MANAGE) or with an API
 * key carrying `webhooks:manage` — in that case the key is confined to its own organisation.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly dispatcher: WebhookDispatcherService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private manager(auth: AuthContext, organizationId?: string) {
    if (auth.apiCredential) {
      // The guard already enforced the webhooks:manage scope; the key only sees its own tenant.
      const own = auth.apiCredential.organizationId;
      if (organizationId && organizationId !== own) throw DomainError.notFound('Organization');
      return { organizationId: own };
    }
    return this.organizations.resolveActingOrganization(auth, organizationId, Permission.API_MANAGE);
  }

  private async load(auth: AuthContext, id: string): Promise<WebhookSubscription> {
    const subscription = await this.prisma.webhookSubscription.findUnique({ where: { id } });
    if (!subscription) throw DomainError.notFound('Webhook');
    this.manager(auth, subscription.organizationId);
    return subscription;
  }

  private encrypt(secret: string) {
    return sealString(this.env, KeyPurpose.WEBHOOKS, secret);
  }

  async list(auth: AuthContext, query: ListWebhooksQuery) {
    const membership = this.manager(auth, query.organizationId);
    const items = await this.prisma.webhookSubscription.findMany({
      where: {
        organizationId: membership.organizationId,
        ...(query.includeRevoked ? {} : { revokedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return { organizationId: membership.organizationId, sandbox: true, items: items.map(toWebhookDto) };
  }

  async get(auth: AuthContext, id: string) {
    return toWebhookDto(await this.load(auth, id));
  }

  async create(auth: AuthContext, input: CreateWebhookRequest, req: Request) {
    const membership = this.manager(auth, input.organizationId);
    assertSafeWebhookUrl(input.url, this.env.NODE_ENV);
    const secret = generateWebhookSecret();
    const subscription = await this.prisma.$transaction(async (tx) => {
      const created = await tx.webhookSubscription.create({
        data: {
          organizationId: membership.organizationId,
          createdByUserId: auth.userId,
          url: input.url,
          description: input.description ?? null,
          secretEnc: this.encrypt(secret),
          events: [...new Set(input.events)],
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: membership.organizationId,
          action: 'webhook.created',
          entityType: 'WebhookSubscription',
          entityId: created.id,
          metadata: { url: created.url, events: created.events, viaApiKey: auth.apiCredential?.id ?? null },
          ...requestMeta(req),
        },
        tx,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'webhook.created',
          title: 'Webhook sandbox créé',
          body: `Un abonnement webhook vers ${created.url} a été créé (${created.events.length} événement(s)). Données fictives — Aucun fonds réel.`,
          data: { webhookId: created.id, organizationId: membership.organizationId },
        },
        tx,
      );
      return created;
    });
    return { webhook: toWebhookDto(subscription), secret, sandbox: true as const };
  }

  async update(auth: AuthContext, id: string, input: UpdateWebhookInput, req: Request) {
    const current = await this.load(auth, id);
    if (current.revokedAt) throw DomainError.conflict('A deleted webhook cannot be updated');
    if (input.url !== undefined) assertSafeWebhookUrl(input.url, this.env.NODE_ENV);
    const reactivating = input.isActive === true && !current.isActive;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.webhookSubscription.update({
        where: { id: current.id },
        data: {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.events !== undefined ? { events: [...new Set(input.events)] } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          // Re-enabling after automatic deactivation starts a fresh failure budget.
          ...(reactivating ? { failureCount: 0 } : {}),
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: current.organizationId,
          action: 'webhook.updated',
          entityType: 'WebhookSubscription',
          entityId: current.id,
          metadata: {
            changes: Object.keys(input),
            isActive: row.isActive,
            viaApiKey: auth.apiCredential?.id ?? null,
          },
          ...requestMeta(req),
        },
        tx,
      );
      return row;
    });
    return toWebhookDto(updated);
  }

  /** Soft delete: the subscription and its delivery history stay visible with includeRevoked. */
  async remove(auth: AuthContext, id: string, req: Request) {
    const current = await this.load(auth, id);
    if (current.revokedAt) throw DomainError.conflict('This webhook is already deleted');
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.webhookSubscription.update({
        where: { id: current.id },
        data: { revokedAt: new Date(), isActive: false },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: current.organizationId,
          action: 'webhook.deleted',
          entityType: 'WebhookSubscription',
          entityId: current.id,
          metadata: { url: current.url, viaApiKey: auth.apiCredential?.id ?? null },
          ...requestMeta(req),
        },
        tx,
      );
      return row;
    });
    return toWebhookDto(updated);
  }

  async rotateSecret(auth: AuthContext, id: string, req: Request) {
    const current = await this.load(auth, id);
    if (current.revokedAt) throw DomainError.conflict('A deleted webhook cannot be rotated');
    const secret = generateWebhookSecret();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.webhookSubscription.update({
        where: { id: current.id },
        data: { secretEnc: this.encrypt(secret), lastRotatedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: current.organizationId,
          action: 'webhook.secret_rotated',
          entityType: 'WebhookSubscription',
          entityId: current.id,
          metadata: { viaApiKey: auth.apiCredential?.id ?? null },
          ...requestMeta(req),
        },
        tx,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'webhook.secret_rotated',
          title: 'Secret de webhook renouvelé',
          body: `Le secret de signature du webhook vers ${current.url} a été renouvelé. Mettez à jour votre intégration.`,
          data: { webhookId: current.id },
        },
        tx,
      );
      return row;
    });
    return { webhook: toWebhookDto(updated), secret, sandbox: true as const };
  }

  /** Sends a synthetic event right away and returns the resulting delivery. */
  async sendTest(auth: AuthContext, id: string, input: SendTestWebhookInput, req: Request) {
    const current = await this.load(auth, id);
    if (current.revokedAt) throw DomainError.conflict('A deleted webhook cannot receive test events');
    const delivery = await this.dispatcher.sendTest(current, input.eventType, auth.userId);
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId: current.organizationId,
      action: 'webhook.test_sent',
      entityType: 'WebhookDelivery',
      entityId: delivery.id,
      metadata: { webhookId: current.id, eventType: input.eventType, status: delivery.status },
      ...requestMeta(req),
    });
    return toWebhookDeliveryDto(delivery);
  }

  async deliveries(auth: AuthContext, id: string, query: WebhookDeliveriesQuery) {
    await this.load(auth, id);
    const where = { subscriptionId: id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return paginate(items.map(toWebhookDeliveryDto), total, query.page, query.pageSize);
  }

  /** Manual retry of a failed / exhausted delivery, regardless of its scheduled attempt time. */
  async retryDelivery(auth: AuthContext, id: string, deliveryId: string, req: Request) {
    const subscription = await this.load(auth, id);
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, subscriptionId: subscription.id },
    });
    if (!delivery) throw DomainError.notFound('Webhook delivery');
    if (delivery.status !== 'FAILED' && delivery.status !== 'EXHAUSTED') {
      throw DomainError.invalidTransition(
        `Only FAILED or EXHAUSTED deliveries can be retried (current: ${delivery.status})`,
        {
          entity: 'WebhookDelivery',
          from: delivery.status,
          to: 'PENDING',
        },
      );
    }
    const result = await this.dispatcher.deliver(delivery.id, 'manual');
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId: subscription.organizationId,
      action: 'webhook.delivery_retried',
      entityType: 'WebhookDelivery',
      entityId: delivery.id,
      metadata: { webhookId: subscription.id, status: result.status, attempts: result.attempts },
      ...requestMeta(req),
    });
    return toWebhookDeliveryDto(result);
  }
}
