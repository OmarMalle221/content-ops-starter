import type { Prisma, RiskAlertStatus, RiskSeverity } from '@dfn/database';
import {
  REVIEW_SLA_DEFAULT_HOURS,
  RISK_ALERT_CLOSED_STATUSES,
  RISK_ALERT_OPEN_STATUSES,
  defineStateMachine,
  type RiskAlertActionName,
} from '@dfn/shared';
import type { Env } from '../../config/env';

export const OPEN_ALERT_STATUSES: RiskAlertStatus[] = [...RISK_ALERT_OPEN_STATUSES];
export const CLOSED_ALERT_STATUSES: RiskAlertStatus[] = [...RISK_ALERT_CLOSED_STATUSES];
export const SEVERITIES: RiskSeverity[] = ['HIGH', 'MEDIUM', 'LOW'];
const SEVERITY_RANK: Record<RiskSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const HOUR_MS = 3_600_000;

export function isOpenAlertStatus(status: RiskAlertStatus): boolean {
  return OPEN_ALERT_STATUSES.includes(status);
}

export function maxSeverity(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function severityAbove(candidate: RiskSeverity, current: RiskSeverity): boolean {
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[current];
}

export type SlaHours = Record<RiskSeverity, number>;

/** Review SLA per severity: REVIEW_SLA_HOURS_* when set, REVIEW_SLA_DEFAULT_HOURS otherwise. */
export function slaHoursFrom(
  env: Pick<Env, 'REVIEW_SLA_HOURS_HIGH' | 'REVIEW_SLA_HOURS_MEDIUM' | 'REVIEW_SLA_HOURS_LOW'>,
): SlaHours {
  return {
    HIGH: env.REVIEW_SLA_HOURS_HIGH ?? REVIEW_SLA_DEFAULT_HOURS.HIGH,
    MEDIUM: env.REVIEW_SLA_HOURS_MEDIUM ?? REVIEW_SLA_DEFAULT_HOURS.MEDIUM,
    LOW: env.REVIEW_SLA_HOURS_LOW ?? REVIEW_SLA_DEFAULT_HOURS.LOW,
  };
}

/** dueAt = start + SLA(severity). `start` is the alert creation (or the reopening on CONTEST). */
export function computeDueAt(start: Date, severity: RiskSeverity, sla: SlaHours): Date {
  return new Date(start.getTime() + sla[severity] * HOUR_MS);
}

/** Stored dueAt, or the deadline derived from the creation date for rows created without one. */
export function effectiveDueAt(
  alert: { dueAt: Date | null; createdAt: Date; severity: RiskSeverity },
  sla: SlaHours,
): Date {
  return alert.dueAt ?? computeDueAt(alert.createdAt, alert.severity, sla);
}

/**
 * Open alerts whose deadline has passed. Rows without a stored dueAt (created by code paths that
 * predate the review SLA) are compared on createdAt + SLA(severity) until the REVIEW_SLA job
 * backfills them.
 */
export function overdueWhere(now: Date, sla: SlaHours): Prisma.RiskAlertWhereInput {
  return {
    status: { in: OPEN_ALERT_STATUSES },
    OR: [
      { dueAt: { lt: now } },
      ...SEVERITIES.map((severity) => ({
        dueAt: null,
        severity,
        createdAt: { lt: new Date(now.getTime() - sla[severity] * HOUR_MS) },
      })),
    ],
  };
}

/** Review lifecycle of a risk alert (actions of POST /v1/admin/risk-alerts/:id/actions). */
export const riskAlertMachine = defineStateMachine<RiskAlertStatus>('RiskAlert', {
  OPEN: ['REVIEWING', 'CONFIRMED', 'DISMISSED'],
  REVIEWING: ['CONFIRMED', 'DISMISSED'],
  // A decision can be contested (by the person concerned, through support), which reopens it.
  CONFIRMED: ['CONTESTED'],
  DISMISSED: ['CONTESTED'],
  CONTESTED: ['REVIEWING', 'CONFIRMED', 'DISMISSED'],
});

export const ACTION_TARGET: Record<RiskAlertActionName, RiskAlertStatus> = {
  START_REVIEW: 'REVIEWING',
  CONFIRM: 'CONFIRMED',
  DISMISS: 'DISMISSED',
  CONTEST: 'CONTESTED',
};

export type ReviewNextAction = RiskAlertActionName | 'ASSIGN' | 'ASSIGN_TO_ME' | 'UNASSIGN';

/** Server-driven actions offered to a staff viewer on an alert. */
export function reviewNextActions(
  alert: { status: RiskAlertStatus; assignedToUserId: string | null },
  viewerUserId: string,
): ReviewNextAction[] {
  const actions: ReviewNextAction[] = (Object.keys(ACTION_TARGET) as RiskAlertActionName[]).filter((a) =>
    riskAlertMachine.canTransition(alert.status, ACTION_TARGET[a]),
  );
  if (isOpenAlertStatus(alert.status)) {
    actions.push('ASSIGN');
    if (alert.assignedToUserId !== viewerUserId) actions.push('ASSIGN_TO_ME');
    if (alert.assignedToUserId) actions.push('UNASSIGN');
  }
  return actions;
}

/** Rule codes whose outcome must never be disclosed to the person concerned (no tipping-off). */
export const CONFIDENTIAL_RULE_CODES = new Set(['STRUCTURING', 'SANCTIONS_POTENTIAL_MATCH']);

/**
 * CSV cell with quoting and formula-injection neutralisation (local copy of the business export
 * helper): a value starting with `=`, `+`, `-`, `@`, tab or carriage return would be evaluated by a
 * spreadsheet, so it is prefixed with an apostrophe and quoted. Plain signed numbers stay as-is.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  const formula = /^[\t\r]*[=+\-@]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str);
  if (formula) str = `'${str}`;
  return formula || /[",\n\r\t]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Parses a YYYY-MM-DD day (inclusive; `end` moves to the next UTC midnight) or an ISO timestamp. */
export function parseDateBoundary(value: string, end: boolean): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  return new Date(value);
}
