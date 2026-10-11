import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma, RiskAlertStatus, RiskSeverity } from '@dfn/database';
import {
  ErrorCode,
  SANDBOX_DISCLAIMER,
  type AssignRiskAlertInput,
  type ExportRiskAlertsQuery,
  type ListRiskAlertsQuery,
  type ReviewQueueSort,
  type RiskAlertActionName,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ACTION_TARGET,
  CLOSED_ALERT_STATUSES,
  CONFIDENTIAL_RULE_CODES,
  OPEN_ALERT_STATUSES,
  computeDueAt,
  csvLine,
  effectiveDueAt,
  isOpenAlertStatus,
  overdueWhere,
  parseDateBoundary,
  reviewNextActions,
  riskAlertMachine,
} from './review-sla';
import { RiskService } from './risk.service';

const MINUTE_MS = 60_000;
/** Rows exported per CSV request (the filters narrow larger queues). */
export const RISK_ALERTS_CSV_MAX_ROWS = 5_000;
/** Window of the "median time to first action" statistic. */
export const STATS_WINDOW_DAYS = 30;

export const RISK_ALERTS_CSV_HEADER =
  'id,created_at,rule_code,severity,score,status,due_at,overdue,sla_breached_at,first_action_at,assigned_to,assigned_to_email,user_email,organization,transaction_reference,summary,resolved_by,resolution_note,resolved_at,age_hours';

const alertInclude = {
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
  organization: { select: { id: true, name: true } },
  transaction: { select: { id: true, reference: true, title: true } },
  assignedTo: { select: { id: true, email: true, firstName: true, lastName: true } },
  resolvedBy: { select: { id: true, firstName: true, lastName: true } },
  actions: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, firstName: true, lastName: true } } },
  },
} satisfies Prisma.RiskAlertInclude;

type AlertRow = Prisma.RiskAlertGetPayload<{ include: typeof alertInclude }>;

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

/**
 * Compliance review queue over RiskAlert: filters, SLA (deadline, overdue, breach), assignment,
 * explainable decisions, CSV export and statistics. Staff only (Permission.ADMIN_RISK); staff see
 * every tenant by design — the queue is a cross-tenant compliance function.
 */
@Injectable()
export class ReviewQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────────── DTO ─────────────────────────────

  toDto(a: AlertRow, viewerUserId: string, now: Date) {
    const sla = this.risk.slaHours;
    const open = isOpenAlertStatus(a.status);
    const dueAt = effectiveDueAt(a, sla);
    const remainingMinutes = Math.floor((dueAt.getTime() - now.getTime()) / MINUTE_MS);
    const ageMinutes = Math.max(0, Math.floor((now.getTime() - a.createdAt.getTime()) / MINUTE_MS));
    return {
      id: a.id,
      ruleCode: a.ruleCode,
      severity: a.severity,
      score: a.score,
      status: a.status,
      explanation: a.explanation,
      createdAt: a.createdAt,
      dueAt,
      overdue: open && remainingMinutes < 0,
      /** Minutes until the deadline (negative once overdue); null for decided alerts. */
      slaRemainingMinutes: open ? remainingMinutes : null,
      slaBreachedAt: a.slaBreachedAt,
      firstActionAt: a.firstActionAt,
      ageMinutes,
      ageHours: Math.floor(ageMinutes / 60),
      assignedTo: a.assignedTo
        ? { id: a.assignedTo.id, name: fullName(a.assignedTo), email: a.assignedTo.email }
        : null,
      assignedAt: a.assignedAt,
      user: a.user,
      organization: a.organization,
      transaction: a.transaction,
      resolvedBy: a.resolvedBy ? { id: a.resolvedBy.id, name: fullName(a.resolvedBy) } : null,
      resolutionNote: a.resolutionNote,
      resolvedAt: a.resolvedAt,
      actions: a.actions.map((x) => ({
        id: x.id,
        action: x.action,
        note: x.note,
        createdAt: x.createdAt,
        actor: x.actor,
      })),
      nextActions: reviewNextActions(a, viewerUserId),
    };
  }

  // ───────────────────────────── Queue ─────────────────────────────

  private where(auth: AuthContext, q: ExportRiskAlertsQuery, now: Date): Prisma.RiskAlertWhereInput {
    const sla = this.risk.slaHours;
    const and: Prisma.RiskAlertWhereInput[] = [];
    if (q.status?.length) and.push({ status: { in: q.status as RiskAlertStatus[] } });
    if (q.severity?.length) and.push({ severity: { in: q.severity as RiskSeverity[] } });
    if (q.ruleCode) and.push({ ruleCode: q.ruleCode });
    if (q.assignee === 'me') and.push({ assignedToUserId: auth.userId });
    else if (q.assignee === 'unassigned') and.push({ assignedToUserId: null });
    else if (q.assignee) and.push({ assignedToUserId: q.assignee });
    if (q.overdue === true) and.push(overdueWhere(now, sla));
    else if (q.overdue === false) and.push({ NOT: overdueWhere(now, sla) });
    if (q.organizationId) and.push({ organizationId: q.organizationId });
    if (q.from) and.push({ createdAt: { gte: parseDateBoundary(q.from, false) } });
    if (q.to) {
      const isDay = /^\d{4}-\d{2}-\d{2}$/.test(q.to);
      const bound = parseDateBoundary(q.to, true);
      and.push({ createdAt: isDay ? { lt: bound } : { lte: bound } });
    }
    return and.length ? { AND: and } : {};
  }

  /** dueAt ascending when the request is about open alerts only, newest first otherwise. */
  private sortOf(q: ExportRiskAlertsQuery): ReviewQueueSort {
    if (q.sort) return q.sort;
    const openOnly =
      q.overdue === true ||
      (Boolean(q.status?.length) && q.status!.every((s) => isOpenAlertStatus(s as RiskAlertStatus)));
    return openOnly ? 'dueAt' : '-createdAt';
  }

  private orderBy(sort: ReviewQueueSort): Prisma.RiskAlertOrderByWithRelationInput[] {
    switch (sort) {
      case 'dueAt':
        return [
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { severity: 'desc' },
          { createdAt: 'asc' },
          { id: 'asc' },
        ];
      case '-dueAt':
        return [{ dueAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }];
      case 'createdAt':
        return [{ createdAt: 'asc' }, { id: 'asc' }];
      case 'severity':
        return [
          { severity: 'desc' },
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ];
      case '-createdAt':
      default:
        return [{ createdAt: 'desc' }, { id: 'desc' }];
    }
  }

  async list(auth: AuthContext, q: ListRiskAlertsQuery) {
    const now = new Date();
    const where = this.where(auth, q, now);
    const sort = this.sortOf(q);
    const [rows, total] = await Promise.all([
      this.prisma.riskAlert.findMany({
        where,
        orderBy: this.orderBy(sort),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: alertInclude,
      }),
      this.prisma.riskAlert.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toDto(r, auth.userId, now)),
      total,
      page: q.page,
      pageSize: q.pageSize,
      sort,
      generatedAt: now,
      slaHours: this.risk.slaHours,
      rules: this.risk.listRules(),
    };
  }

  async get(auth: AuthContext, id: string) {
    const row = await this.prisma.riskAlert.findUnique({ where: { id }, include: alertInclude });
    if (!row) throw DomainError.notFound('Risk alert');
    return this.toDto(row, auth.userId, new Date());
  }

  /** Filtered queue as CSV (formula-injection safe), with the sandbox disclaimer line. Audited. */
  async csv(auth: AuthContext, q: ExportRiskAlertsQuery, req: Request) {
    const now = new Date();
    const where = this.where(auth, q, now);
    const sort = this.sortOf(q);
    const [rows, total] = await Promise.all([
      this.prisma.riskAlert.findMany({
        where,
        orderBy: this.orderBy(sort),
        take: RISK_ALERTS_CSV_MAX_ROWS,
        include: alertInclude,
      }),
      this.prisma.riskAlert.count({ where }),
    ]);
    const lines = rows.map((r) => {
      const d = this.toDto(r, auth.userId, now);
      const summary = (r.explanation as { summary?: unknown } | null)?.summary;
      return csvLine([
        d.id,
        d.createdAt,
        d.ruleCode,
        d.severity,
        d.score,
        d.status,
        d.dueAt,
        d.overdue ? 'true' : 'false',
        d.slaBreachedAt,
        d.firstActionAt,
        d.assignedTo?.name,
        d.assignedTo?.email,
        r.user?.email,
        r.organization?.name,
        r.transaction?.reference,
        typeof summary === 'string' ? summary : '',
        d.resolvedBy?.name,
        d.resolutionNote,
        d.resolvedAt,
        d.ageHours,
      ]);
    });
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.risk_alerts_exported',
      entityType: 'RiskAlert',
      metadata: { filters: { ...q }, sort, rows: rows.length, total },
      ...requestMeta(req),
    });
    return [
      `# Diaspora Trust — SANDBOX compliance review queue (risk alerts). ${SANDBOX_DISCLAIMER.fr}`,
      RISK_ALERTS_CSV_HEADER,
      ...lines,
      ...(total > rows.length
        ? [`# truncated: ${rows.length} of ${total} alerts exported — narrow the filters`]
        : []),
    ].join('\n');
  }

  async stats(auth: AuthContext) {
    const now = new Date();
    const sla = this.risk.slaHours;
    const open = { status: { in: OPEN_ALERT_STATUSES } } satisfies Prisma.RiskAlertWhereInput;
    const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 24 * 60 * MINUTE_MS);
    const [byStatus, bySeverity, overdue, unassigned, assignedToMe, breached, median] = await Promise.all([
      this.prisma.riskAlert.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.riskAlert.groupBy({ by: ['severity'], where: open, _count: { _all: true } }),
      this.prisma.riskAlert.count({ where: overdueWhere(now, sla) }),
      this.prisma.riskAlert.count({ where: { ...open, assignedToUserId: null } }),
      this.prisma.riskAlert.count({ where: { ...open, assignedToUserId: auth.userId } }),
      this.prisma.riskAlert.count({ where: { ...open, slaBreachedAt: { not: null } } }),
      this.prisma.$queryRaw<Array<{ median: number | null; n: number }>>`
        SELECT percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM ("firstActionAt" - "createdAt"))::float8
               ) AS median,
               COUNT(*)::int AS n
        FROM "RiskAlert"
        WHERE "createdAt" >= ${since} AND "firstActionAt" IS NOT NULL`,
    ]);
    const statusCounts = Object.fromEntries(
      ['OPEN', 'REVIEWING', 'CONFIRMED', 'DISMISSED', 'CONTESTED'].map((s) => [
        s,
        byStatus.find((b) => b.status === s)?._count._all ?? 0,
      ]),
    ) as Record<RiskAlertStatus, number>;
    const severityCounts = Object.fromEntries(
      (['HIGH', 'MEDIUM', 'LOW'] as const).map((s) => [
        s,
        bySeverity.find((b) => b.severity === s)?._count._all ?? 0,
      ]),
    ) as Record<RiskSeverity, number>;
    const medianSeconds = median[0]?.median;
    return {
      sandbox: true as const,
      generatedAt: now,
      byStatus: statusCounts,
      /** Open alerts (OPEN, REVIEWING, CONTESTED) per severity. */
      openBySeverity: severityCounts,
      open: OPEN_ALERT_STATUSES.reduce((acc, s) => acc + statusCounts[s], 0),
      overdue,
      unassigned,
      assignedToMe,
      slaBreached: breached,
      medianTimeToFirstAction: {
        windowDays: STATS_WINDOW_DAYS,
        sampleSize: Number(median[0]?.n ?? 0),
        minutes: medianSeconds == null ? null : Math.round(Number(medianSeconds) / 60),
      },
      slaHours: sla,
    };
  }

  /** Staff who can be assigned an alert (ACTIVE COMPLIANCE or ADMIN users). */
  async assignees() {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null, globalRole: { in: ['COMPLIANCE', 'ADMIN'] } },
      select: { id: true, firstName: true, lastName: true, email: true, globalRole: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 200,
    });
    return {
      items: users.map((u) => ({ id: u.id, name: fullName(u), email: u.email, globalRole: u.globalRole })),
    };
  }

  // ───────────────────────────── Assignment ─────────────────────────────

  async assign(auth: AuthContext, id: string, input: AssignRiskAlertInput, req: Request) {
    const alert = await this.prisma.riskAlert.findUnique({ where: { id } });
    if (!alert) throw DomainError.notFound('Risk alert');
    if (CLOSED_ALERT_STATUSES.includes(alert.status)) {
      throw new DomainError(
        ErrorCode.ALERT_NOT_ASSIGNABLE,
        `A decided alert (${alert.status}) cannot be assigned`,
        HttpStatus.CONFLICT,
        { status: alert.status },
      );
    }
    const assigneeId = input.assigneeUserId === 'me' ? auth.userId : input.assigneeUserId;
    let assignee: { id: string; firstName: string; lastName: string } | null = null;
    if (assigneeId) {
      assignee = await this.prisma.user.findFirst({
        where: {
          id: assigneeId,
          status: 'ACTIVE',
          deletedAt: null,
          globalRole: { in: ['COMPLIANCE', 'ADMIN'] },
        },
        select: { id: true, firstName: true, lastName: true },
      });
      if (!assignee) {
        throw new DomainError(
          ErrorCode.ALERT_NOT_ASSIGNABLE,
          'The assignee must be an active compliance or administrator user',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { assigneeUserId: assigneeId },
        );
      }
    }
    if ((alert.assignedToUserId ?? null) === (assigneeId ?? null)) return this.get(auth, id);

    const now = new Date();
    await this.prisma.$transaction(async (db) => {
      // Guarded on the state read above: a concurrent decision or reassignment fails this update.
      const res = await db.riskAlert.updateMany({
        where: { id, status: { in: OPEN_ALERT_STATUSES }, assignedToUserId: alert.assignedToUserId },
        data: { assignedToUserId: assigneeId ?? null, assignedAt: assigneeId ? now : null },
      });
      if (res.count !== 1) throw DomainError.conflict('The alert changed meanwhile, reload and retry');
      await db.riskAlertAction.create({
        data: {
          alertId: id,
          actorUserId: auth.userId,
          action: assigneeId ? 'ASSIGN' : 'UNASSIGN',
          note: assignee ? fullName(assignee) : null,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: assigneeId ? 'admin.risk_alert_assigned' : 'admin.risk_alert_unassigned',
          entityType: 'RiskAlert',
          entityId: id,
          metadata: { from: alert.assignedToUserId, to: assigneeId ?? null, ruleCode: alert.ruleCode },
          ...requestMeta(req),
        },
        db,
      );
    });
    if (assigneeId && assigneeId !== auth.userId) {
      await this.notifications.notify({
        userId: assigneeId,
        type: 'risk.alert_assigned',
        title: `Alerte de conformité assignée — ${alert.ruleCode}`,
        body: `${auth.firstName} ${auth.lastName} vous a assigné une alerte ${alert.severity} (${alert.ruleCode}). Échéance de revue : ${effectiveDueAt(alert, this.risk.slaHours).toISOString()} (sandbox).`,
        data: { alertId: id, ruleCode: alert.ruleCode, severity: alert.severity },
      });
    }
    return this.get(auth, id);
  }

  // ───────────────────────────── Decisions ─────────────────────────────

  /**
   * START_REVIEW / CONFIRM / DISMISS / CONTEST with a mandatory note (schema). Records the actor,
   * the first staff action (firstActionAt) and, for decisions, resolvedBy / resolvedAt. CONTEST
   * reopens a decision with a new SLA cycle. START_REVIEW on an unassigned alert assigns it to the
   * reviewer.
   */
  async act(auth: AuthContext, id: string, action: RiskAlertActionName, note: string, req: Request) {
    const alert = await this.prisma.riskAlert.findUnique({ where: { id } });
    if (!alert) throw DomainError.notFound('Risk alert');
    const target = ACTION_TARGET[action];
    riskAlertMachine.assertTransition(alert.status, target);
    const now = new Date();
    const decision = action === 'CONFIRM' || action === 'DISMISS';
    const autoAssign = action === 'START_REVIEW' && !alert.assignedToUserId;
    await this.prisma.$transaction(async (db) => {
      const res = await db.riskAlert.updateMany({
        where: { id, status: alert.status },
        data: {
          status: target,
          firstActionAt: alert.firstActionAt ?? now,
          ...(decision ? { resolvedById: auth.userId, resolutionNote: note, resolvedAt: now } : {}),
          ...(autoAssign ? { assignedToUserId: auth.userId, assignedAt: now } : {}),
          ...(action === 'CONTEST'
            ? { dueAt: computeDueAt(now, alert.severity, this.risk.slaHours), slaBreachedAt: null }
            : {}),
        },
      });
      if (res.count !== 1) {
        throw DomainError.invalidTransition('The alert changed meanwhile, reload and retry', {
          entity: 'RiskAlert',
          from: alert.status,
          to: target,
        });
      }
      await db.riskAlertAction.create({ data: { alertId: id, actorUserId: auth.userId, action, note } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'admin.risk_alert_action',
          entityType: 'RiskAlert',
          entityId: id,
          metadata: {
            action,
            from: alert.status,
            to: target,
            ruleCode: alert.ruleCode,
            ...(autoAssign ? { autoAssignedTo: auth.userId } : {}),
          },
          ...requestMeta(req),
        },
        db,
      );
    });
    // The person concerned is informed of decisions, except for rules whose disclosure could tip
    // off a possible suspicious transaction report (structuring, sanctions screening).
    if (alert.userId && action !== 'START_REVIEW' && !CONFIDENTIAL_RULE_CODES.has(alert.ruleCode)) {
      await this.notifications.notify({
        userId: alert.userId,
        type: 'risk.alert_resolved',
        title: 'Revue de conformité',
        body: `Une alerte sur votre compte a été traitée (${target}). Vous pouvez contester cette décision via le support.`,
        data: { alertId: id },
      });
    }
    return this.get(auth, id);
  }
}
