import { z } from 'zod';
import { GlobalRole, UserStatusEnum } from './admin-enums';
import { foldBracketParams, reviewQueueFiltersShape } from './reviews';

export const updateUserStatusSchema = z.object({
  status: z.nativeEnum(UserStatusEnum),
  reason: z.string().trim().min(3).max(1000),
});

export const updateUserRoleSchema = z.object({ globalRole: z.nativeEnum(GlobalRole) });

export const riskAlertActionSchema = z.object({
  action: z.enum(['START_REVIEW', 'CONFIRM', 'DISMISS', 'CONTEST']),
  note: z.string().trim().min(3).max(2000),
});

export const listAuditLogsQuerySchema = z.object({
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(80).optional(),
  actorUserId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Compliance review queue (GET /v1/admin/risk-alerts): repeated or comma-separated `status` and
 * `severity`, `ruleCode`, `assignee=me|unassigned|<uuid>`, `overdue=true`, `organizationId`,
 * `from`/`to` (creation date), `sort`, page pagination capped at 100.
 */
export const listRiskAlertsQuerySchema = z.preprocess(
  foldBracketParams,
  z.object({
    ...reviewQueueFiltersShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type ListRiskAlertsQuery = z.infer<typeof listRiskAlertsQuerySchema>;

export const sandboxDepositSchema = z.object({
  organizationId: z.string().uuid(),
  currencyCode: z.string().length(3),
  amount: z.string().regex(/^\d{1,13}([.,]\d{1,2})?$/),
  note: z.string().trim().max(200).optional(),
});
