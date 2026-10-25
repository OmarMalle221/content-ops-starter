/**
 * Review queue URL state — shared by the server page and the client filters (no 'use client':
 * plain functions must stay callable on the server). Every URL value is validated here before it
 * reaches the API, so a hand-edited URL never breaks the page.
 */
import { REVIEW_QUEUE_SORTS, RISK_ALERT_CLOSED_STATUSES, RISK_ALERT_OPEN_STATUSES } from '@dfn/shared';

export const REVIEW_QUEUE_PATH = '/admin/risk';
export const REVIEW_QUEUE_PAGE_SIZE = 25;
export const REVIEW_QUEUE_VIEWS = ['open', 'closed', 'all'] as const;
export type ReviewQueueView = (typeof REVIEW_QUEUE_VIEWS)[number];
export const REVIEW_QUEUE_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

/** Filters of the queue as they appear in the page URL. */
export interface ReviewQueueFilterState {
  view: ReviewQueueView;
  severity?: string;
  ruleCode?: string;
  assignee?: string;
  overdue?: boolean;
  organizationId?: string;
  from?: string;
  to?: string;
  sort?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_RE = /^[A-Z0-9_]{2,60}$/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Sanitises the page search params into a filter state and a page number. */
export function parseReviewQueueParams(sp: Record<string, string | string[] | undefined>): {
  filters: ReviewQueueFilterState;
  page: number;
} {
  const view = one(sp.view);
  const severity = one(sp.severity);
  const ruleCode = one(sp.ruleCode);
  const assignee = one(sp.assignee);
  const organizationId = one(sp.organizationId);
  const from = one(sp.from);
  const to = one(sp.to);
  const sort = one(sp.sort);
  const page = Number.parseInt(one(sp.page) ?? '1', 10);
  return {
    filters: {
      view: (REVIEW_QUEUE_VIEWS as readonly string[]).includes(view ?? '')
        ? (view as ReviewQueueView)
        : 'open',
      severity: (REVIEW_QUEUE_SEVERITIES as readonly string[]).includes(severity ?? '')
        ? severity
        : undefined,
      ruleCode: ruleCode && RULE_RE.test(ruleCode) ? ruleCode : undefined,
      assignee:
        assignee === 'me' || assignee === 'unassigned' || (assignee && UUID_RE.test(assignee))
          ? assignee
          : undefined,
      overdue: one(sp.overdue) === 'true' || undefined,
      organizationId: organizationId && UUID_RE.test(organizationId) ? organizationId : undefined,
      from: from && DAY_RE.test(from) ? from : undefined,
      to: to && DAY_RE.test(to) ? to : undefined,
      sort: (REVIEW_QUEUE_SORTS as readonly string[]).includes(sort ?? '') ? sort : undefined,
    },
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Page URL query of a filter state (changing a filter goes back to page 1). */
export function reviewQueueSearch(f: ReviewQueueFilterState, page?: number): string {
  const p = new URLSearchParams();
  if (f.view !== 'open') p.set('view', f.view);
  if (f.severity) p.set('severity', f.severity);
  if (f.ruleCode) p.set('ruleCode', f.ruleCode);
  if (f.assignee) p.set('assignee', f.assignee);
  if (f.overdue) p.set('overdue', 'true');
  if (f.organizationId) p.set('organizationId', f.organizationId);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.sort) p.set('sort', f.sort);
  if (page && page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** API query (GET /v1/admin/risk-alerts and .csv) of a filter state. */
export function reviewQueueApiQuery(f: ReviewQueueFilterState, page?: number, pageSize?: number): string {
  const p = new URLSearchParams();
  if (f.view === 'open') p.set('status', RISK_ALERT_OPEN_STATUSES.join(','));
  if (f.view === 'closed') p.set('status', RISK_ALERT_CLOSED_STATUSES.join(','));
  if (f.severity) p.set('severity', f.severity);
  if (f.ruleCode) p.set('ruleCode', f.ruleCode);
  if (f.assignee) p.set('assignee', f.assignee);
  if (f.overdue) p.set('overdue', 'true');
  if (f.organizationId) p.set('organizationId', f.organizationId);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.sort) p.set('sort', f.sort);
  if (page) p.set('page', String(page));
  if (pageSize) p.set('pageSize', String(pageSize));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}
