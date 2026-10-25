import { Injectable, OnModuleInit } from '@nestjs/common';
import { MaintenanceJobName } from '@dfn/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobRegistry, type JobResult } from '../jobs/job-registry';

/** Ended (expired or revoked) sessions are kept this long for support and incident analysis. */
export const SESSION_RETENTION_DAYS = 7;
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

/**
 * AUTH_CLEANUP maintenance job: purges WebAuthn challenges that are expired or already used (a
 * deleted challenge can never be answered: lookups require the row) and sessions that ended more
 * than 7 days ago. Idempotent, batch-bounded (at most MAX_BATCHES × BATCH_SIZE rows per table and
 * run; `truncated` tells the next run has more to do).
 */
@Injectable()
export class AuthCleanupService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(MaintenanceJobName.AUTH_CLEANUP, () => this.run());
  }

  async run(now = new Date()): Promise<JobResult> {
    const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * 24 * 3600 * 1000);
    const challenges = await this.purgeInBatches((take) =>
      this.prisma.authChallenge
        .findMany({
          where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take,
        })
        .then(async (rows) => {
          if (!rows.length) return 0;
          const res = await this.prisma.authChallenge.deleteMany({
            where: { id: { in: rows.map((r) => r.id) } },
          });
          return res.count;
        }),
    );
    const sessions = await this.purgeInBatches((take) =>
      this.prisma.session
        .findMany({
          where: { OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }] },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take,
        })
        .then(async (rows) => {
          if (!rows.length) return 0;
          const res = await this.prisma.session.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
          return res.count;
        }),
    );
    return {
      summary: {
        challengesPurged: challenges.purged,
        sessionsPurged: sessions.purged,
        sessionRetentionDays: SESSION_RETENTION_DAYS,
        truncated: challenges.truncated || sessions.truncated,
      },
    };
  }

  private async purgeInBatches(batch: (take: number) => Promise<number>) {
    let purged = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const count = await batch(BATCH_SIZE);
      purged += count;
      if (count < BATCH_SIZE) return { purged, truncated: false };
    }
    return { purged, truncated: true };
  }
}
