import { z } from 'zod';
import { ALL_API_SCOPES, ALL_WEBHOOK_EVENTS } from '../enums';

export const createApiCredentialSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  scopes: z
    .array(z.enum(ALL_API_SCOPES as [string, ...string[]]))
    .min(1)
    .max(20),
  rateLimitPerMinute: z.number().int().min(10).max(1000).default(120),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
export type CreateApiCredentialInput = z.infer<typeof createApiCredentialSchema>;

export const createWebhookSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//.test(u), 'URL must be http(s)'),
  description: z.string().trim().max(300).optional(),
  events: z
    .array(z.enum(ALL_WEBHOOK_EVENTS as [string, ...string[]]))
    .min(1)
    .max(30),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = createWebhookSchema.partial().extend({ isActive: z.boolean().optional() });

export const sendTestWebhookSchema = z.object({
  eventType: z.enum(ALL_WEBHOOK_EVENTS as [string, ...string[]]).default('transaction.created'),
});

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const idempotencyKeySchema = z.string().trim().min(8).max(128);

// ── Request wrappers used by the Diaspora API console (additive, backward compatible) ──────────

/** Body of POST /v1/api-credentials: the organisation the key belongs to defaults to the personal workspace. */
export const createApiCredentialRequestSchema = createApiCredentialSchema.extend({
  organizationId: z.string().uuid().optional(),
});
export type CreateApiCredentialRequest = z.infer<typeof createApiCredentialRequestSchema>;

export const listApiCredentialsQuerySchema = z.object({
  organizationId: z.string().uuid().optional(),
  includeRevoked: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});
export type ListApiCredentialsQuery = z.infer<typeof listApiCredentialsQuerySchema>;

export const apiRequestLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ApiRequestLogsQuery = z.infer<typeof apiRequestLogsQuerySchema>;

/** Body of POST /v1/webhooks. */
export const createWebhookRequestSchema = createWebhookSchema.extend({
  organizationId: z.string().uuid().optional(),
});
export type CreateWebhookRequest = z.infer<typeof createWebhookRequestSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
export type SendTestWebhookInput = z.infer<typeof sendTestWebhookSchema>;

export const listWebhooksQuerySchema = z.object({
  organizationId: z.string().uuid().optional(),
  includeRevoked: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});
export type ListWebhooksQuery = z.infer<typeof listWebhooksQuerySchema>;

export const webhookDeliveriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED']).optional(),
});
export type WebhookDeliveriesQuery = z.infer<typeof webhookDeliveriesQuerySchema>;

/** Error codes specific to the Diaspora API platform (stable, documented in docs/api/PARTNERS.md). */
export const ApiPlatformErrorCode = {
  SCOPE_FORBIDDEN: 'SCOPE_FORBIDDEN',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  API_KEY_INVALID: 'API_KEY_INVALID',
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',
  WEBHOOK_URL_FORBIDDEN: 'WEBHOOK_URL_FORBIDDEN',
} as const;
export type ApiPlatformErrorCode = (typeof ApiPlatformErrorCode)[keyof typeof ApiPlatformErrorCode];

/** Prefix of every sandbox secret key. Live keys do not exist in this build. */
export const API_KEY_PREFIX = 'dfn_sk_';
