import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MaintenanceJobName, type MaintenanceRun, type Prisma } from '@dfn/database';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { paginate } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { heartbeatIntervalMs, JobLeaseStore, type JobLeaseDto, type TakenOverLease } from './job-lease';
import { JobRegistry, type JobHandler } from './job-registry';

/** Prefix of the error recorded on runs whose lease expired (crash, partition, stolen lease). */
export const LEASE_EXPIRED = 'lease expired';
/** Prefix of the error recorded when a running handler is aborted because its lease was lost. */
export const LEASE_LOST = 'lease lost';

/** Raised (as the abort reason) when the runner can no longer prove it owns the job lease. */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
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
    instanceId: run.instanceId,
    heartbeatAt: run.heartbeatAt,
  };
}

export function toLeaseDto(lease: JobLeaseDto) {
  return {
    jobName: lease.jobName,
    ownerId: lease.ownerId,
    runId: lease.runId,
    acquiredAt: lease.acquiredAt,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt,
    expired: lease.expired,
  };
}

/**
 * Executes registered maintenance jobs and records every execution as a MaintenanceRun row
 * (RUNNING → COMPLETED | FAILED), under a LEASE (JobLease table) rather than a lock held by an open
 * transaction:
 *
 *  1. acquire the lease of the job (atomic upsert that only succeeds when the lease is free or
 *     expired) — otherwise 409 JOB_ALREADY_RUNNING (manual triggers) / skip (scheduler);
 *  2. when an expired lease was taken over, the RUNNING run(s) left behind by the dead owner are
 *     closed as FAILED ("lease expired …");
 *  3. the handler runs with `{ triggeredBy, signal, runId }` while a heartbeat renews the lease
 *     (and MaintenanceRun.heartbeatAt) every JOB_LEASE_SECONDS / 3;
 *  4. if a renewal is refused (the lease was taken over) — or renewals keep failing for a whole
 *     lease period — the signal is aborted and the run is closed FAILED ("lease lost …") right
 *     away, even if the handler ignores the signal;
 *  5. the lease is released (deleted) only if this replica and this run still own it.
 *
 * Several MaintenanceService instances (API replicas, or tests with distinct INSTANCE_IDs) can
 * therefore never execute the same job concurrently, and a crashed replica blocks a job for at
 * most JOB_LEASE_SECONDS. No database connection is held for the duration of a run.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  readonly leases: JobLeaseStore;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.leases = new JobLeaseStore(prisma, env.INSTANCE_ID, env.JOB_LEASE_SECONDS);
  }

  get schedulerEnabled(): boolean {
    return this.env.JOBS_ENABLED && this.env.NODE_ENV !== 'test';
  }

  get instanceId(): string {
    return this.env.INSTANCE_ID;
  }

  /** Runs one job now. Resolves with the finished MaintenanceRun (COMPLETED or FAILED). */
  async run(jobName: MaintenanceJobName, triggeredBy: string): Promise<MaintenanceRun> {
    const handler = this.registry.get(jobName);
    if (!handler) {
      throw new DomainError(
        ErrorCode.JOB_NOT_REGISTERED,
        `Job ${jobName} has no registered handler`,
        HttpStatus.NOT_FOUND,
        { jobName },
      );
    }
    const runId = randomUUID();
    const acquired = await this.leases.acquire(jobName, runId);
    if (!acquired) {
      const holder = await this.leases.get(jobName).catch(() => null);
      throw new DomainError(
        ErrorCode.JOB_ALREADY_RUNNING,
        `Job ${jobName} is already running`,
        HttpStatus.CONFLICT,
        { jobName, ownerId: holder?.ownerId ?? null, expiresAt: holder?.expiresAt ?? null },
      );
    }
    let run: MaintenanceRun;
    try {
      await this.closeAbandonedRuns(jobName, runId, acquired.takenOver);
      run = await this.prisma.maintenanceRun.create({
        data: { id: runId, jobName, triggeredBy, instanceId: this.instanceId, heartbeatAt: new Date() },
      });
    } catch (err) {
      await this.leases.release(jobName, runId).catch(() => undefined);
      throw err;
    }
    this.logger.log(
      `job ${jobName} started (run ${run.id}, triggered by ${triggeredBy}, instance ${this.instanceId})`,
    );
    return this.execute(run, handler);
  }

  /**
   * Runs left RUNNING without a live lease belong to a replica that died (or lost its lease):
   * holding the lease now proves nobody else is executing the job, so they are closed FAILED.
   */
  private async closeAbandonedRuns(
    jobName: MaintenanceJobName,
    currentRunId: string,
    takenOver: TakenOverLease | null,
  ) {
    const error = takenOver
      ? `${LEASE_EXPIRED}: instance ${takenOver.ownerId} stopped renewing its lease; taken over by ${this.instanceId}`
      : `${LEASE_EXPIRED}: no live lease for this run (instance stopped or crashed); closed by ${this.instanceId}`;
    const closed = await this.prisma.maintenanceRun.updateMany({
      where: { jobName, status: 'RUNNING', id: { not: currentRunId } },
      data: { status: 'FAILED', finishedAt: new Date(), error },
    });
    if (closed.count > 0) {
      this.logger.warn(`job ${jobName}: ${closed.count} abandoned run(s) closed as FAILED (${error})`);
    }
  }

  private async execute(run: MaintenanceRun, handler: JobHandler): Promise<MaintenanceRun> {
    const { jobName } = run;
    const controller = new AbortController();
    const leaseMs = this.leases.leaseSeconds * 1000;
    let lastRenewal = Date.now();
    let renewing = false;
    let settled = false;

    const lose = (message: string) => {
      if (settled || controller.signal.aborted) return;
      this.logger.error(`job ${jobName} (run ${run.id}): ${message} — aborting`);
      controller.abort(new LeaseLostError(message));
    };
    const heartbeat = setInterval(() => {
      if (renewing || settled || controller.signal.aborted) return;
      renewing = true;
      this.heartbeat(run)
        .then((renewed) => {
          if (renewed) lastRenewal = Date.now();
          else lose(`${LEASE_LOST}: the lease of ${jobName} was taken over by another instance`);
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          if (Date.now() - lastRenewal >= leaseMs) {
            lose(`${LEASE_LOST}: lease could not be renewed for ${this.leases.leaseSeconds}s (${reason})`);
          } else {
            this.logger.warn(`job ${jobName} (run ${run.id}): heartbeat failed, will retry: ${reason}`);
          }
        })
        .finally(() => {
          renewing = false;
        });
    }, heartbeatIntervalMs(this.leases.leaseSeconds));

    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => undefined);

    try {
      const execution = Promise.resolve().then(() =>
        handler({ triggeredBy: run.triggeredBy, signal: controller.signal, runId: run.id }),
      );
      // A handler that ignores the signal may settle after its run was closed: never unhandled.
      execution.catch(() => undefined);
      const result = await Promise.race([execution, aborted]);
      settled = true;
      clearInterval(heartbeat);
      return await this.finish(run.id, {
        status: 'COMPLETED',
        summary: sanitizeSummary(result?.summary),
      });
    } catch (err) {
      settled = true;
      clearInterval(heartbeat);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`job ${jobName} failed (run ${run.id}): ${message}`);
      return await this.finish(run.id, { status: 'FAILED', error: message.slice(0, 2000) });
    } finally {
      settled = true;
      clearInterval(heartbeat);
      await this.leases.release(jobName, run.id).catch((err: unknown) => {
        // The lease simply expires after JOB_LEASE_SECONDS if it cannot be deleted now.
        this.logger.warn(
          `job ${jobName} (run ${run.id}): lease release failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /** Renews the lease, then stamps the run; false when the lease is no longer ours. */
  private async heartbeat(run: MaintenanceRun): Promise<boolean> {
    const renewed = await this.leases.renew(run.jobName, run.id);
    if (renewed) {
      // Informational stamp: failing to write it must not count as a failed renewal.
      await this.prisma.maintenanceRun
        .updateMany({
          where: { id: run.id, status: 'RUNNING' },
          data: { heartbeatAt: new Date(), instanceId: this.instanceId },
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `job ${run.jobName} (run ${run.id}): heartbeat stamp failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    return renewed;
  }

  /**
   * Closes the run unless someone else already did (an instance that took the lease over closes
   * our run as FAILED "lease expired" — that verdict is kept).
   */
  private async finish(
    runId: string,
    outcome: { status: 'COMPLETED'; summary: Prisma.InputJsonObject } | { status: 'FAILED'; error: string },
  ): Promise<MaintenanceRun> {
    const closed = await this.prisma.maintenanceRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { ...outcome, finishedAt: new Date() },
    });
    const run = await this.prisma.maintenanceRun.findUniqueOrThrow({ where: { id: runId } });
    if (closed.count === 0) {
      this.logger.warn(
        `job ${run.jobName} (run ${runId}) was already closed as ${run.status}: ${run.error ?? ''}`,
      );
    } else if (run.status === 'COMPLETED') {
      this.logger.log(`job ${run.jobName} completed (run ${runId})`);
    }
    return run;
  }

  /** Current leases (live and expired-but-not-yet-taken-over), with the database clock verdict. */
  async listLeases() {
    return (await this.leases.list()).map(toLeaseDto);
  }

  /** Every job name known to the schema, whether a handler is registered, its latest run and lease. */
  async listJobs() {
    const names = Object.values(MaintenanceJobName);
    const [lastRuns, leases] = await Promise.all([
      this.prisma.maintenanceRun.findMany({
        distinct: ['jobName'],
        orderBy: [{ jobName: 'asc' }, { startedAt: 'desc' }],
      }),
      this.listLeases(),
    ]);
    const byName = new Map(lastRuns.map((r) => [r.jobName, r]));
    const leaseByName = new Map(leases.map((l) => [l.jobName, l]));
    return {
      sandbox: true,
      schedulerEnabled: this.schedulerEnabled,
      driver: this.env.JOBS_DRIVER,
      instanceId: this.instanceId,
      leaseSeconds: this.leases.leaseSeconds,
      intervalMinutes: this.env.JOBS_INTERVAL_MINUTES,
      anonymizeAfterDays: this.env.ANONYMIZE_AFTER_DAYS,
      leases,
      jobs: names.map((name) => {
        const last = byName.get(name);
        return {
          name,
          registered: this.registry.has(name),
          lastRun: last ? toRunDto(last) : null,
          lease: leaseByName.get(name) ?? null,
        };
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
