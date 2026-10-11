import { Injectable, Logger } from '@nestjs/common';
import { RiskEngine, type RiskFacts } from '@dfn/compliance';
import type { Prisma } from '@dfn/database';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Bridges the pure rules engine with persistence. Alerts are advisory and land in the
 * compliance review queue; nothing is blocked automatically.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);
  private readonly engine = new RiskEngine();

  constructor(private readonly prisma: PrismaService) {}

  listRules() {
    return this.engine.listRules();
  }

  async evaluateAndRecord(facts: RiskFacts, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const evaluation = this.engine.evaluate(facts);
    for (const signal of evaluation.signals) {
      await db.riskAlert.create({
        data: {
          userId: facts.userId ?? null,
          organizationId: facts.organizationId ?? null,
          transactionId: facts.transactionId ?? null,
          ruleCode: signal.ruleCode,
          severity: signal.severity,
          score: signal.score,
          explanation: signal.explanation as unknown as Prisma.InputJsonValue,
        },
      });
    }
    if (evaluation.signals.length) {
      this.logger.log(
        `risk: ${facts.event} → ${evaluation.signals.map((s) => s.ruleCode).join(',')} (${evaluation.totalScore})`,
      );
    }
    return evaluation;
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
