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
