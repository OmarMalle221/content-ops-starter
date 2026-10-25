import type { ApiCredential, ApiRequestLog, WebhookDelivery, WebhookSubscription } from '@dfn/database';
import { API_KEY_PREFIX } from '@dfn/shared';

export type ApiCredentialStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface CredentialCreator {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type ApiCredentialWithCreator = ApiCredential & { createdBy: CredentialCreator | null };

export function credentialStatus(c: ApiCredential, now = new Date()): ApiCredentialStatus {
  if (c.revokedAt) return 'REVOKED';
  if (c.expiresAt && c.expiresAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

/** Masked display form: prefix only — the secret part is never stored, so it can never be shown again. */
export function keyDisplay(keyPrefix: string): string {
  return `${API_KEY_PREFIX}${keyPrefix}_${'•'.repeat(12)}`;
}

/** Actions the console may offer for a credential, derived server-side. */
export function credentialNextActions(status: ApiCredentialStatus): string[] {
  return status === 'ACTIVE' ? ['ROTATE', 'REVOKE'] : [];
}

export function toApiCredentialDto(c: ApiCredentialWithCreator, now = new Date()) {
  const status = credentialStatus(c, now);
  return {
    id: c.id,
    organizationId: c.organizationId,
    name: c.name,
    description: c.description,
    keyPrefix: c.keyPrefix,
    keyDisplay: keyDisplay(c.keyPrefix),
    scopes: c.scopes,
    rateLimitPerMinute: c.rateLimitPerMinute,
    rotatedFromId: c.rotatedFromId,
    expiresAt: c.expiresAt,
    lastUsedAt: c.lastUsedAt,
    revokedAt: c.revokedAt,
    createdAt: c.createdAt,
    createdBy: c.createdBy
      ? {
          id: c.createdBy.id,
          email: c.createdBy.email,
          firstName: c.createdBy.firstName,
          lastName: c.createdBy.lastName,
        }
      : null,
    status,
    nextActions: credentialNextActions(status),
    sandbox: true as const,
  };
}
export type ApiCredentialDto = ReturnType<typeof toApiCredentialDto>;

export function toApiRequestLogDto(l: ApiRequestLog) {
  return {
    id: l.id,
    credentialId: l.credentialId,
    method: l.method,
    path: l.path,
    statusCode: l.statusCode,
    durationMs: l.durationMs,
    ip: l.ip,
    requestId: l.requestId,
    createdAt: l.createdAt,
  };
}

export type WebhookStatus = 'ACTIVE' | 'INACTIVE' | 'REVOKED';

export function webhookStatus(s: WebhookSubscription): WebhookStatus {
  if (s.revokedAt) return 'REVOKED';
  return s.isActive ? 'ACTIVE' : 'INACTIVE';
}

export function webhookNextActions(status: WebhookStatus): string[] {
  if (status === 'REVOKED') return [];
  const actions = ['EDIT', 'ROTATE_SECRET', 'SEND_TEST', 'DELETE'];
  actions.push(status === 'ACTIVE' ? 'DISABLE' : 'ENABLE');
  return actions;
}

/** The signing secret never appears in this DTO: it is returned once at creation / rotation only. */
export function toWebhookDto(s: WebhookSubscription) {
  const status = webhookStatus(s);
  return {
    id: s.id,
    organizationId: s.organizationId,
    url: s.url,
    description: s.description,
    events: s.events,
    isActive: s.isActive,
    failureCount: s.failureCount,
    lastDeliveryAt: s.lastDeliveryAt,
    lastRotatedAt: s.lastRotatedAt,
    createdAt: s.createdAt,
    revokedAt: s.revokedAt,
    status,
    nextActions: webhookNextActions(status),
    sandbox: true as const,
  };
}
export type WebhookDto = ReturnType<typeof toWebhookDto>;

export function deliveryNextActions(d: WebhookDelivery, now = new Date()): string[] {
  // A delivery being sent (live claim) cannot be retried until that attempt completes.
  const beingSent = d.claimedUntil !== null && d.claimedUntil > now;
  return (d.status === 'FAILED' || d.status === 'EXHAUSTED') && !beingSent ? ['RETRY'] : [];
}

export function toWebhookDeliveryDto(d: WebhookDelivery) {
  return {
    id: d.id,
    subscriptionId: d.subscriptionId,
    eventType: d.eventType,
    eventId: d.eventId,
    payload: d.payload,
    signature: d.signature,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
    nextActions: deliveryNextActions(d),
    sandbox: true as const,
  };
}
export type WebhookDeliveryDto = ReturnType<typeof toWebhookDeliveryDto>;
