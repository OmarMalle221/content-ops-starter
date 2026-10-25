/**
 * Phase 6 — compliance review queues (risk alerts): constants and request schemas (zod).
 * Owned by the reviews work area. The list query itself is `listRiskAlertsQuerySchema` (admin.ts).
 */
import { z } from 'zod';
import { RiskAlertStatus, RiskSeverity } from '../enums';

/** Statuses of an alert still awaiting a decision (they carry an SLA deadline). */
export const RISK_ALERT_OPEN_STATUSES = [
  RiskAlertStatus.OPEN,
  RiskAlertStatus.REVIEWING,
  RiskAlertStatus.CONTESTED,
] as const;

/** Statuses of a decided alert (no SLA, cannot be (re)assigned). */
export const RISK_ALERT_CLOSED_STATUSES = [RiskAlertStatus.CONFIRMED, RiskAlertStatus.DISMISSED] as const;

export const RISK_ALERT_ACTIONS = ['START_REVIEW', 'CONFIRM', 'DISMISS', 'CONTEST'] as const;
export type RiskAlertActionName = (typeof RISK_ALERT_ACTIONS)[number];

/**
 * Sort orders of the review queue. Default: `dueAt` (oldest deadline first) when only open statuses
 * are requested, `-createdAt` otherwise.
 */
export const REVIEW_QUEUE_SORTS = ['dueAt', '-dueAt', 'createdAt', '-createdAt', 'severity'] as const;
export type ReviewQueueSort = (typeof REVIEW_QUEUE_SORTS)[number];

/** `assignee` filter: the viewer, nobody, or a staff user id. */
export const reviewAssigneeFilterSchema = z.union([
  z.literal('me'),
  z.literal('unassigned'),
  z.string().uuid(),
]);

/** Accepts `a,b`, repeated parameters (`?x=a&x=b`) or arrays; empty values are ignored. */
export function csvListSchema<T extends z.ZodTypeAny>(item: T, max = 10) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  }, z.array(item).max(max).optional());
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A day (`YYYY-MM-DD`, UTC) or an ISO 8601 timestamp. */
export const dateBoundarySchema = z
  .string()
  .trim()
  .refine(
    (v) =>
      (DAY_RE.test(v) || ISO_RE.test(v)) && !Number.isNaN(Date.parse(DAY_RE.test(v) ? `${v}T00:00:00Z` : v)),
    {
      message: 'Expected YYYY-MM-DD or an ISO 8601 timestamp',
    },
  );

export const reviewQueueFiltersShape = {
  status: csvListSchema(z.nativeEnum(RiskAlertStatus)),
  severity: csvListSchema(z.nativeEnum(RiskSeverity)),
  ruleCode: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{2,60}$/, 'Invalid rule code')
    .optional(),
  assignee: reviewAssigneeFilterSchema.optional(),
  overdue: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
  organizationId: z.string().uuid().optional(),
  /** Creation date range (inclusive; a bare day covers the whole UTC day). */
  from: dateBoundarySchema.optional(),
  to: dateBoundarySchema.optional(),
  sort: z.enum(REVIEW_QUEUE_SORTS).optional(),
};

/** `status[]=…` / `severity[]=…` (bracket notation) are folded into `status` / `severity`. */
export function foldBracketParams(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of ['status', 'severity']) {
    const bracket = out[`${key}[]`];
    if (bracket !== undefined) {
      const current = out[key];
      out[key] = [
        ...(current === undefined ? [] : Array.isArray(current) ? current : [current]),
        ...(Array.isArray(bracket) ? bracket : [bracket]),
      ];
      delete out[`${key}[]`];
    }
  }
  return out;
}

/** Same filters as the list, without pagination (CSV export). */
export const exportRiskAlertsQuerySchema = z.preprocess(foldBracketParams, z.object(reviewQueueFiltersShape));
export type ExportRiskAlertsQuery = z.infer<typeof exportRiskAlertsQuerySchema>;

/**
 * Assign an alert: a staff user id, `"me"` (the caller) or `null` (unassign). The assignee must be
 * an ACTIVE COMPLIANCE or ADMIN user; decided alerts cannot be (re)assigned.
 */
export const assignRiskAlertSchema = z.object({
  assigneeUserId: z.union([z.string().uuid(), z.literal('me')]).nullable(),
});
export type AssignRiskAlertInput = z.infer<typeof assignRiskAlertSchema>;
