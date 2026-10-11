/** DTO shapes returned by the Diaspora API platform endpoints (apps/api/src/modules/api-platform). */

export interface ScopeOption {
  scope: string;
  description: { fr: string; en: string };
}

export interface Catalog {
  sandbox: boolean;
  keyPrefix: string;
  scopes: ScopeOption[];
  webhookEvents: string[];
  docsPath: string;
}

export type CredentialStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface ApiCredential {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  keyDisplay: string;
  scopes: string[];
  rateLimitPerMinute: number;
  rotatedFromId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: { id: string; email: string; firstName: string; lastName: string } | null;
  status: CredentialStatus;
  nextActions: string[];
}

export interface ApiRequestLog {
  id: string;
  credentialId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

export type WebhookStatus = 'ACTIVE' | 'INACTIVE' | 'REVOKED';

export interface Webhook {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  failureCount: number;
  lastDeliveryAt: string | null;
  lastRotatedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  status: WebhookStatus;
  nextActions: string[];
}

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'EXHAUSTED';

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  nextActions: string[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type DevTab = 'keys' | 'webhooks' | 'logs';

/** Builds a /developers URL; undefined values are dropped so links stay short and deterministic. */
export function devHref(
  organizationId: string,
  tab: DevTab,
  extra: Record<string, string | number | undefined> = {},
): string {
  const qs = new URLSearchParams({ organizationId, tab });
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  return `/developers?${qs.toString()}`;
}
