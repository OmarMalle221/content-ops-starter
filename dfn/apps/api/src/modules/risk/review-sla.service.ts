import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { MaintenanceJobName } from '@dfn/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isEligibleStaff, staffUserWhere } from '../../common/staff-recipients';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { JobRegistry, type JobResult } from '../jobs/job-registry';
import { NotificationsService } from '../notifications/notifications.service';
import { OPEN_ALERT_STATUSES, computeDueAt, slaHoursFrom } from './review-sla';

const BATCH_SIZE = 200;
const MAX_BATCHES = 10;

/** Optional fields the job runner may pass (abort on lease loss); the base context stays valid. */
interface ReviewSlaContext {
  triggeredBy: string;
  signal?: AbortSignal;
}

/**
 * REVIEW_SLA maintenance job:
 *
 *  1. backfills `dueAt` (createdAt + REVIEW_SLA_HOURS_<SEVERITY>) on open alerts created without one;
 *  2. marks `slaBreachedAt` on open alerts (OPEN, REVIEWING, CONTESTED) past their deadline and
 *     notifies the assignee — or every active COMPLIANCE / ADMIN user when the alert is unassigned
 *     or its assignee is no longer active staff (under REQUIRE_STAFF_MFA, staff without two-factor
 *     authentication count as non-staff on both sides).
 *
 * Idempotent: the breach marker is claimed with a conditional update (`slaBreachedAt IS NULL`), so
 * one breach is notified once, even with concurrent runs. Batch-bounded (MAX_BATCHES × BATCH_SIZE
 * rows per step and run); `truncated` tells the next run has more to do.
 */
@Injectable()
export class ReviewSlaService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.registry.register(MaintenanceJobName.REVIEW_SLA, (ctx: ReviewSlaContext) => this.run(ctx));
  }

  async run(ctx: ReviewSlaContext = { triggeredBy: 'manual' }, now = new Date()): Promise<JobResult> {
    const sla = slaHoursFrom(this.env);
    let truncated = false;

    // 1. Deadlines of alerts created without one (code paths predating the review SLA).
    let dueAtBackfilled = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      if (ctx.signal?.aborted) break;
      const rows = await this.prisma.riskAlert.findMany({
        where: { status: { in: OPEN_ALERT_STATUSES }, dueAt: null },
        select: { id: true, createdAt: true, severity: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });
      for (const r of rows) {
        const res = await this.prisma.riskAlert.updateMany({
          where: { id: r.id, dueAt: null },
          data: { dueAt: computeDueAt(r.createdAt, r.severity, sla) },
        });
        dueAtBackfilled += res.count;
      }
      if (rows.length < BATCH_SIZE) break;
      if (i === MAX_BATCHES - 1) truncated = true;
    }

    // 2. Breaches.
    let staff: string[] | null = null;
    const staffIds = async () => {
      staff ??= (
        await this.prisma.user.findMany({
          where: staffUserWhere(this.env),
          select: { id: true },
        })
      ).map((u) => u.id);
      return staff;
    };
    let breached = 0;
    let notifications = 0;
    let notifiedAssignee = 0;
    let notifiedStaff = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      if (ctx.signal?.aborted) break;
      const rows = await this.prisma.riskAlert.findMany({
        where: { status: { in: OPEN_ALERT_STATUSES }, slaBreachedAt: null, dueAt: { lt: now } },
        select: {
          id: true,
          ruleCode: true,
          severity: true,
          status: true,
          dueAt: true,
          organizationId: true,
          assignedTo: {
            select: { id: true, status: true, globalRole: true, deletedAt: true, mfaEnabled: true },
          },
        },
        orderBy: { dueAt: 'asc' },
        take: BATCH_SIZE,
      });
      for (const alert of rows) {
        const claimed = await this.prisma.riskAlert.updateMany({
          where: { id: alert.id, slaBreachedAt: null, status: { in: OPEN_ALERT_STATUSES } },
          data: { slaBreachedAt: now },
        });
        if (claimed.count !== 1) continue;
        breached++;
        const a = alert.assignedTo;
        const assigneeActive = a && isEligibleStaff(this.env, a);
        const recipients = assigneeActive ? [a.id] : await staffIds();
        if (assigneeActive) notifiedAssignee++;
        else notifiedStaff++;
        const due = alert.dueAt!.toISOString();
        await this.notifications.notifyMany(recipients, {
          type: 'risk.review_sla_breached',
          title: `Échéance de revue dépassée — ${alert.ruleCode}`,
          body: `L'alerte ${alert.severity} (${alert.ruleCode}, ${alert.status}) devait être traitée avant le ${due}. ${
            assigneeActive ? 'Elle vous est assignée.' : "Elle n'est assignée à personne."
          } (sandbox — données fictives)`,
          data: { alertId: alert.id, ruleCode: alert.ruleCode, severity: alert.severity, dueAt: due },
        });
        notifications += new Set(recipients).size;
        await this.audit.log({
          actorUserId: null,
          organizationId: alert.organizationId,
          action: 'risk.review_sla_breached',
          entityType: 'RiskAlert',
          entityId: alert.id,
          metadata: {
            dueAt: due,
            severity: alert.severity,
            assignedToUserId: assigneeActive ? a.id : null,
            recipients: new Set(recipients).size,
            triggeredBy: ctx.triggeredBy,
          },
        });
      }
      if (rows.length < BATCH_SIZE) break;
      if (i === MAX_BATCHES - 1) truncated = true;
    }

    return {
      summary: {
        dueAtBackfilled,
        breached,
        notifications,
        notifiedAssignee,
        notifiedStaff,
        slaHours: sla,
        truncated,
        aborted: Boolean(ctx.signal?.aborted),
      },
    };
  }
}
