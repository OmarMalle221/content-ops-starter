import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { MaintenanceJobName } from '@dfn/database';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { RedisConnectionService } from '../../common/redis';
import { ENV, type Env } from '../../config/env';
import { JobRegistry } from './job-registry';
import { MaintenanceService } from './maintenance.service';

/** BullMQ queue shared by every replica (keys `bull:dfn-maintenance:*`). */
export const MAINTENANCE_QUEUE = 'dfn-maintenance';
/** Triggered-by label of executions started by the BullMQ driver. */
export const BULLMQ_TRIGGER = 'scheduler:bullmq';
/** A worker gets this long to finish its current job on shutdown before it is force-closed. */
const WORKER_CLOSE_TIMEOUT_MS = 10_000;

/** Stable id of the repeatable schedule of a job: one schedule per job, whatever the replica count. */
export function schedulerIdFor(jobName: MaintenanceJobName): string {
  return `maintenance-${jobName}`;
}

export interface MaintenanceJobData {
  jobName: MaintenanceJobName;
  triggeredBy?: string;
}

export interface MaintenanceJobOutcome {
  jobName: MaintenanceJobName;
  runId?: string;
  status?: string;
  skipped?: 'already_running' | 'not_registered';
}

export interface SchedulerStatus {
  driver: Env['JOBS_DRIVER'];
  enabled: boolean;
  started: boolean;
  queue: string | null;
  /** Next planned execution per job (BullMQ: from the job schedulers; in-process: next tick). */
  nextRuns: Partial<Record<MaintenanceJobName, string>>;
  error?: string;
}

/** Retries are disabled at the BullMQ level: the lease and the next tick handle failures. */
const JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
} as const;

const isJobName = (value: unknown): value is MaintenanceJobName =>
  typeof value === 'string' && (Object.values(MaintenanceJobName) as string[]).includes(value);

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Triggers the registered maintenance jobs every JOBS_INTERVAL_MINUTES, with one of two drivers
 * (JOBS_DRIVER). Both call the same lease-protected runner (MaintenanceService.run), so a job never
 * runs twice at once whatever the number of replicas.
 *
 *  - `inprocess` (default): a timer in each replica runs every registered job sequentially. With
 *    N replicas a job may run up to N times per interval (one after the other, never concurrently).
 *  - `bullmq`: one repeatable job scheduler per registered job in the "dfn-maintenance" queue
 *    (stable scheduler id → a single schedule for the whole fleet), and one Worker per replica
 *    (concurrency 1). Each tick is executed once, by whichever replica picks it up.
 *
 * The scheduler starts after application bootstrap (every module has registered its handlers by
 * then); it is disabled in tests and when JOBS_ENABLED=false (tests call `start()` explicitly).
 */
@Injectable()
export class JobsSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private nextTickAt?: Date;
  private ticking = false;
  private queue?: Queue<MaintenanceJobData, MaintenanceJobOutcome>;
  private worker?: Worker<MaintenanceJobData, MaintenanceJobOutcome>;
  private starting?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly registry: JobRegistry,
    private readonly maintenance: MaintenanceService,
    private readonly redis: RedisConnectionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get driver(): Env['JOBS_DRIVER'] {
    return this.env.JOBS_DRIVER;
  }

  get started(): boolean {
    return Boolean(this.timer || this.worker);
  }

  onApplicationBootstrap() {
    if (!this.maintenance.schedulerEnabled) {
      this.logger.log('scheduler disabled (JOBS_ENABLED=false or test environment)');
      return;
    }
    // Never block the bootstrap on Redis: BullMQ commands wait for the connection to come back.
    this.start().catch((err: unknown) =>
      this.logger.error(`scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** Starts the configured driver once (idempotent). */
  start(): Promise<void> {
    this.starting ??= this.env.JOBS_DRIVER === 'bullmq' ? this.startBullmq() : this.startInProcess();
    return this.starting;
  }

  async onModuleDestroy() {
    await this.stop();
  }

  /** Stops the timer, then closes the worker (after its current job) and the queue. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.nextTickAt = undefined;
    const worker = this.worker;
    const queue = this.queue;
    this.worker = undefined;
    this.queue = undefined;
    if (worker) {
      const closed = await withTimeout(worker.close(), WORKER_CLOSE_TIMEOUT_MS).catch(() => 'timeout');
      if (closed === 'timeout') {
        this.logger.warn('worker did not finish its current job in time — force-closing');
        await worker.close(true).catch(() => undefined);
      }
    }
    if (queue) await withTimeout(queue.close(), WORKER_CLOSE_TIMEOUT_MS).catch(() => undefined);
  }

  private async startInProcess() {
    const intervalMs = this.env.JOBS_INTERVAL_MINUTES * 60_000;
    this.nextTickAt = new Date(Date.now() + intervalMs);
    this.timer = setInterval(() => {
      this.nextTickAt = new Date(Date.now() + intervalMs);
      void this.tick('scheduler');
    }, intervalMs);
    this.timer.unref();
    this.logger.log(
      `scheduler started (inprocess): ${this.registry.list().length} job(s) every ${this.env.JOBS_INTERVAL_MINUTES} min`,
    );
  }

  private async startBullmq() {
    // One dedicated connection for the queue and the worker's regular commands; the Worker
    // duplicates it for its blocking commands and closes that duplicate itself.
    const connection = this.redis.createConnection('bullmq', { maxRetriesPerRequest: null });
    const queue = new Queue<MaintenanceJobData, MaintenanceJobOutcome>(MAINTENANCE_QUEUE, {
      connection,
      defaultJobOptions: JOB_OPTIONS,
    });
    queue.on('error', (err) => this.logger.warn(`queue error: ${err.message}`));
    this.queue = queue;
    const every = this.env.JOBS_INTERVAL_MINUTES * 60_000;
    const names = this.registry.list();
    for (const jobName of names) {
      // Upsert is idempotent on the scheduler id: replicas (re)starting concurrently converge on
      // one schedule per job. `startDate` only applies when the schedule is created: the first
      // execution happens one interval later, like the in-process timer.
      await queue.upsertJobScheduler(
        schedulerIdFor(jobName),
        { every, startDate: new Date(Date.now() + every) },
        { name: jobName, data: { jobName, triggeredBy: BULLMQ_TRIGGER }, opts: JOB_OPTIONS },
      );
    }
    if (this.stopped) return;
    const worker = new Worker<MaintenanceJobData, MaintenanceJobOutcome>(
      MAINTENANCE_QUEUE,
      (job) => this.process(job),
      {
        connection,
        concurrency: 1,
        // A stalled job (replica crashed mid-run) is failed, not re-executed: the lease of the
        // dead replica expires and the next scheduled tick runs the job again.
        maxStalledCount: 0,
      },
    );
    worker.on('error', (err) => this.logger.warn(`worker error: ${err.message}`));
    worker.on('failed', (job, err) =>
      this.logger.error(`bullmq job ${job?.name ?? '?'} (${job?.id ?? '?'}) failed: ${err.message}`),
    );
    this.worker = worker;
    this.logger.log(
      `scheduler started (bullmq, queue ${MAINTENANCE_QUEUE}): ${names.length} job(s) every ${this.env.JOBS_INTERVAL_MINUTES} min, instance ${this.env.INSTANCE_ID}`,
    );
  }

  /** BullMQ processor: the same lease-protected runner as every other trigger. */
  async process(job: Job<MaintenanceJobData>): Promise<MaintenanceJobOutcome> {
    const { jobName } = job.data ?? {};
    if (!isJobName(jobName)) throw new Error(`invalid maintenance job payload (${job.name})`);
    if (!this.registry.has(jobName)) return { jobName, skipped: 'not_registered' };
    const triggeredBy =
      typeof job.data.triggeredBy === 'string' && job.data.triggeredBy.length <= 120
        ? job.data.triggeredBy
        : BULLMQ_TRIGGER;
    try {
      const run = await this.maintenance.run(jobName, triggeredBy);
      return { jobName, runId: run.id, status: run.status };
    } catch (err) {
      if (err instanceof DomainError && err.code === ErrorCode.JOB_ALREADY_RUNNING) {
        this.logger.warn(`job ${jobName} skipped: already running elsewhere`);
        return { jobName, skipped: 'already_running' };
      }
      throw err;
    }
  }

  /**
   * Queues a one-off execution (BullMQ driver only); any replica's worker runs it through the
   * lease-protected runner. Returns the BullMQ job id.
   */
  async enqueue(jobName: MaintenanceJobName, triggeredBy = BULLMQ_TRIGGER): Promise<string> {
    if (!this.queue) throw new Error('the BullMQ driver is not started');
    const job = await this.queue.add(jobName, { jobName, triggeredBy }, JOB_OPTIONS);
    return String(job.id);
  }

  /** The BullMQ job schedulers currently stored in Redis (one per job name). */
  async schedules() {
    if (!this.queue) return [];
    return this.queue.getJobSchedulers(0, -1, true);
  }

  /** Driver state and next planned executions, for the admin console. Never throws. */
  async status(): Promise<SchedulerStatus> {
    const base: SchedulerStatus = {
      driver: this.env.JOBS_DRIVER,
      enabled: this.maintenance.schedulerEnabled,
      started: this.started,
      queue: this.env.JOBS_DRIVER === 'bullmq' ? MAINTENANCE_QUEUE : null,
      nextRuns: {},
    };
    if (this.env.JOBS_DRIVER === 'inprocess') {
      if (this.nextTickAt) {
        for (const name of this.registry.list()) base.nextRuns[name] = this.nextTickAt.toISOString();
      }
      return base;
    }
    if (!this.queue) return base;
    try {
      const schedules = await withTimeout(this.schedules(), 2_000);
      if (schedules === 'timeout') return { ...base, error: 'redis timeout' };
      for (const schedule of schedules) {
        const name = schedule.template?.data?.jobName ?? schedule.name;
        if (isJobName(name) && typeof schedule.next === 'number') {
          base.nextRuns[name] = new Date(schedule.next).toISOString();
        }
      }
      return base;
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Runs every registered job once, sequentially (in-process driver). Never throws. */
  async tick(triggeredBy = 'scheduler'): Promise<{ ran: string[]; skipped: string[]; failed: string[] }> {
    const outcome = { ran: [] as string[], skipped: [] as string[], failed: [] as string[] };
    if (this.ticking) {
      this.logger.warn('previous scheduler tick still running — skipping this one');
      return outcome;
    }
    this.ticking = true;
    try {
      for (const name of this.registry.list()) {
        try {
          const run = await this.maintenance.run(name, triggeredBy);
          (run.status === 'COMPLETED' ? outcome.ran : outcome.failed).push(name);
        } catch (err) {
          if (err instanceof DomainError && err.code === ErrorCode.JOB_ALREADY_RUNNING) {
            outcome.skipped.push(name);
            this.logger.warn(`job ${name} skipped: already running elsewhere`);
          } else {
            outcome.failed.push(name);
            this.logger.error(`job ${name} crashed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
    return outcome;
  }
}
