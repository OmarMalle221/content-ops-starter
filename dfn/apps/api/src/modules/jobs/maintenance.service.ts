import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { MaintenanceJobName, type MaintenanceRun, type Prisma } from '@dfn/database';
import { DomainError } from '../../common/domain-error';
import { paginate } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { JobRegistry } from './job-registry';

/** Namespace (first int key) of the PostgreSQL advisory locks that serialise job executions. */
export const JOB_LOCK_NAMESPACE = 7474;
/** A single run may hold the lock for at most this long (interactive transaction timeout). */
const LOCK_TIMEOUT_MS = 15 * 60_000;

/** Deterministic 32-bit signed key for pg_try_advisory_xact_lock(int, int) — FNV-1a. */
export function jobLockKey(jobName: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < jobName.length; i++) {
    hash ^= jobName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** Summaries are stored as JSON: BigInt minor units become strings, undefined is dropped. */
export function sanitizeSummary(summary: Record<string, unknown> | undefined): Prisma.InputJsonObject {
  return JSON.parse(
    JSON.stringify(summary ?? {}, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  ) as Prisma.InputJsonObject;
}

export function toRunDto(run: MaintenanceRun) {
  return {
    id: run.id,
    jobName: run.jobName,
    status: run.status,
    triggeredBy: run.triggeredBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    summary: run.summary,
    error: run.error,
  };
}

/**
 * Executes registered maintenance jobs and records every execution as a MaintenanceRun row
 * (RUNNING → COMPLETED | FAILED). Concurrent executions of the same job (several API replicas,
 * scheduler + manual trigger) are prevented with a PostgreSQL advisory lock held for the
 * duration of the run: the lock is taken with pg_try_advisory_xact_lock inside an interactive
 * transaction so that acquisition and release always happen on the same connection, and it is
 * released automatically when that transaction ends (commit, rollback or connection loss).
 *
 * BullMQ repeatable jobs (Redis-backed, with per-job retries and distributed workers) are the
 * planned evolution of this in-process scheduler; the handler contract (JobRegistry) stays the same.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get schedulerEnabled(): boolean {
    return this.env.JOBS_ENABLED && this.env.NODE_ENV !== 'test';
  }

  /** Runs one job now. Resolves with the finished MaintenanceRun (COMPLETED or FAILED). */
  async run(jobName: MaintenanceJobName, triggeredBy: string): Promise<MaintenanceRun> {
    const handler = this.registry.get(jobName);
    if (!handler) {
      throw new DomainError(
        'JOB_NOT_REGISTERED',
        `Job ${jobName} has no registered handler`,
        HttpStatus.NOT_FOUND,
        { jobName },
      );
    }
    return this.prisma.$transaction(
      async (lockDb) => {
        const rows = await lockDb.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${JOB_LOCK_NAMESPACE}::int, ${jobLockKey(jobName)}::int) AS locked`;
        if (!rows[0]?.locked) {
          throw new DomainError(
            'JOB_ALREADY_RUNNING',
            `Job ${jobName} is already running`,
            HttpStatus.CONFLICT,
            { jobName },
          );
        }
        // The run row is written outside the lock transaction so that it is visible immediately.
        const run = await this.prisma.maintenanceRun.create({ data: { jobName, triggeredBy } });
        this.logger.log(`job ${jobName} started (run ${run.id}, triggered by ${triggeredBy})`);
        try {
          const result = await handler({ triggeredBy });
          const finished = await this.prisma.maintenanceRun.update({
            where: { id: run.id },
            data: { status: 'COMPLETED', finishedAt: new Date(), summary: sanitizeSummary(result?.summary) },
          });
          this.logger.log(`job ${jobName} completed (run ${run.id})`);
          return finished;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`job ${jobName} failed (run ${run.id}): ${message}`);
          return this.prisma.maintenanceRun.update({
            where: { id: run.id },
            data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2000) },
          });
        }
      },
      { timeout: LOCK_TIMEOUT_MS, maxWait: 5_000 },
    );
  }

  /** Every job name known to the schema, whether a handler is registered and its latest run. */
  async listJobs() {
    const names = Object.values(MaintenanceJobName);
    const lastRuns = await this.prisma.maintenanceRun.findMany({
      distinct: ['jobName'],
      orderBy: [{ jobName: 'asc' }, { startedAt: 'desc' }],
    });
    const byName = new Map(lastRuns.map((r) => [r.jobName, r]));
    return {
      sandbox: true,
      schedulerEnabled: this.schedulerEnabled,
      intervalMinutes: this.env.JOBS_INTERVAL_MINUTES,
      anonymizeAfterDays: this.env.ANONYMIZE_AFTER_DAYS,
      jobs: names.map((name) => {
        const last = byName.get(name);
        return { name, registered: this.registry.has(name), lastRun: last ? toRunDto(last) : null };
      }),
    };
  }

  async listRuns(jobName: MaintenanceJobName | undefined, page: number, pageSize: number) {
    const where = jobName ? { jobName } : {};
    const [items, total] = await Promise.all([
      this.prisma.maintenanceRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.maintenanceRun.count({ where }),
    ]);
    return paginate(items.map(toRunDto), total, page, pageSize);
  }
}
