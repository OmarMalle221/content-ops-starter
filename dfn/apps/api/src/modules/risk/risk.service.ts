import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RiskEngine,
  STRUCTURING_EVENT_KINDS,
  STRUCTURING_RULE_CODE,
  type RiskFacts,
  type RiskSignal,
} from '@dfn/compliance';
import type { Prisma, RiskSeverity } from '@dfn/database';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { OPEN_ALERT_STATUSES, computeDueAt, severityAbove, slaHoursFrom, type SlaHours } from './review-sla';
import { StructuringFactsService } from './structuring-facts.service';

type Db = Prisma.TransactionClient | PrismaService;

/** Repeated detections appended to an open STRUCTURING alert (most recent kept). */
const MAX_STRUCTURING_UPDATES = 20;

function isRootClient(db: Db): db is PrismaService {
  return typeof (db as PrismaService).$transaction === 'function';
}

/**
 * Bridges the pure rules engine with persistence. Alerts are advisory and land in the
 * compliance review queue; nothing is blocked automatically.
 *
 * Every alert gets its review deadline at creation: dueAt = createdAt + REVIEW_SLA_HOURS_<SEVERITY>.
 * STRUCTURING alerts are de-duplicated: one open alert per subject, currency and direction within
 * the window; later detections are appended to it (and may raise its severity, never lower it).
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);
  private readonly engine = new RiskEngine();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly structuring: StructuringFactsService,
    private readonly audit: AuditService,
  ) {}

  listRules() {
    return this.engine.listRules();
  }

  /** Review SLA (hours) per severity. */
  get slaHours(): SlaHours {
    return slaHoursFrom(this.env);
  }

  /** Review deadline of an alert of this severity created at `createdAt`. */
  slaDueAt(severity: RiskSeverity, createdAt = new Date()): Date {
    return computeDueAt(createdAt, severity, this.slaHours);
  }

  async evaluateAndRecord(facts: RiskFacts, db: Db = this.prisma) {
    const now = new Date();
    let enriched = facts;
    if (!facts.structuring && STRUCTURING_EVENT_KINDS[facts.event]) {
      try {
        const structuring = await this.structuring.collect(facts, now, db);
        if (structuring) enriched = { ...facts, structuring };
      } catch (err) {
        // Detection must never break the business operation that triggered it.
        this.logger.warn(
          `risk: structuring facts unavailable for ${facts.event}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const evaluation = this.engine.evaluate(enriched);
    for (const signal of evaluation.signals) {
      if (signal.ruleCode === STRUCTURING_RULE_CODE) {
        await this.recordStructuring(enriched, signal, now, db);
      } else {
        await this.createAlert(facts, signal, now, db);
      }
    }
    if (evaluation.signals.length) {
      this.logger.log(
        `risk: ${facts.event} → ${evaluation.signals.map((s) => s.ruleCode).join(',')} (${evaluation.totalScore})`,
      );
    }
    return evaluation;
  }

  private createAlert(facts: RiskFacts, signal: RiskSignal, now: Date, db: Db) {
    return db.riskAlert.create({
      data: {
        userId: facts.userId ?? null,
        organizationId: facts.organizationId ?? null,
        transactionId: facts.transactionId ?? null,
        ruleCode: signal.ruleCode,
        severity: signal.severity,
        score: signal.score,
        explanation: signal.explanation as unknown as Prisma.InputJsonValue,
        createdAt: now,
        dueAt: this.slaDueAt(signal.severity, now),
      },
    });
  }

  /**
   * One open STRUCTURING alert per subject / currency / direction within the window. Serialised on
   * the de-duplication key with a transaction-scoped advisory lock, so concurrent operations of the
   * same subject cannot open two alerts.
   */
  private async recordStructuring(facts: RiskFacts, signal: RiskSignal, now: Date, db: Db) {
    const factors = signal.explanation.factors;
    const dedupKey = String(factors.dedupKey);
    const windowHours = Number(factors.windowHours) || this.env.STRUCTURING_WINDOW_HOURS;
    const since = new Date(now.getTime() - windowHours * 3_600_000);
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupKey}))`;
      const existing = await tx.riskAlert.findFirst({
        where: {
          ruleCode: STRUCTURING_RULE_CODE,
          status: { in: OPEN_ALERT_STATUSES },
          createdAt: { gte: since },
          explanation: { path: ['factors', 'dedupKey'], equals: dedupKey },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) {
        const created = await this.createAlert(facts, signal, now, tx);
        await this.audit.log(
          {
            actorUserId: null,
            organizationId: facts.organizationId ?? null,
            action: 'risk.structuring_detected',
            entityType: 'RiskAlert',
            entityId: created.id,
            metadata: {
              event: facts.event,
              severity: signal.severity,
              operationsCount: factors.operationsCount,
              sum: factors.sum,
              currencyCode: factors.currencyCode,
              subjectType: factors.subjectType,
            },
          },
          tx,
        );
        return;
      }
      const previous = (existing.explanation ?? {}) as Record<string, unknown>;
      const updates = Array.isArray(previous.updates) ? [...(previous.updates as unknown[])] : [];
      updates.push({
        at: now.toISOString(),
        event: facts.event,
        severity: signal.severity,
        operationsCount: factors.operationsCount,
        sum: factors.sum,
        references: factors.references,
      });
      const escalate = severityAbove(signal.severity, existing.severity);
      const currentDue = existing.dueAt ?? this.slaDueAt(existing.severity, existing.createdAt);
      const escalatedDue = this.slaDueAt(signal.severity, existing.createdAt);
      // The original explanation stays as detected; repeated detections are appended (bounded).
      await tx.riskAlert.update({
        where: { id: existing.id },
        data: {
          explanation: {
            ...previous,
            updates: updates.slice(-MAX_STRUCTURING_UPDATES),
          } as Prisma.InputJsonValue,
          ...(escalate
            ? {
                severity: signal.severity,
                score: Math.max(existing.score, signal.score),
                dueAt: escalatedDue < currentDue ? escalatedDue : currentDue,
              }
            : {}),
        },
      });
      await this.audit.log(
        {
          actorUserId: null,
          organizationId: facts.organizationId ?? existing.organizationId,
          action: escalate ? 'risk.alert_escalated' : 'risk.structuring_repeated',
          entityType: 'RiskAlert',
          entityId: existing.id,
          metadata: {
            event: facts.event,
            from: existing.severity,
            to: escalate ? signal.severity : existing.severity,
            operationsCount: factors.operationsCount,
            sum: factors.sum,
            currencyCode: factors.currencyCode,
          },
        },
        tx,
      );
    };
    if (isRootClient(db)) await db.$transaction(run);
    else await run(db);
  }

  /** Facts helpers used by the transaction workflow. */
  async transactionFacts(params: {
    userId: string;
    organizationId: string;
    amountMinor: bigint;
    currencyCode: string;
    originCountry: string;
    destinationCountry: string;
    corridorSupported: boolean;
  }): Promise<Omit<RiskFacts, 'event' | 'transactionId'>> {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [user, last24h, history, disputes, verification] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: params.userId },
        select: { country: true, createdAt: true },
      }),
      this.prisma.transaction.count({
        where: { buyerOrganizationId: params.organizationId, createdAt: { gte: since24h } },
      }),
      this.prisma.transaction.aggregate({
        where: {
          buyerOrganizationId: params.organizationId,
          currencyCode: params.currencyCode,
          createdAt: { gte: since30d },
        },
        _avg: { amountMinor: true },
        _count: true,
      }),
      this.prisma.dispute.count({
        where: { transaction: { parties: { some: { userId: params.userId } } } },
      }),
      this.prisma.identityVerification.findFirst({
        where: { userId: params.userId, status: 'SIMULATED_PASS' },
        select: { id: true },
      }),
    ]);
    const avg = history._avg.amountMinor;
    return {
      userId: params.userId,
      organizationId: params.organizationId,
      amountMinor: params.amountMinor,
      currencyCode: params.currencyCode,
      averageAmountMinor: avg ? BigInt(Math.round(Number(avg))) : null,
      transactionsLast24h: last24h,
      transactionsLast30d: history._count,
      disputesAsPartyTotal: disputes,
      identityVerified: Boolean(verification),
      userCountry: user?.country ?? undefined,
      originCountry: params.originCountry,
      destinationCountry: params.destinationCountry,
      corridorSupported: params.corridorSupported,
      accountAgeDays: user ? Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000) : undefined,
    };
  }
}
