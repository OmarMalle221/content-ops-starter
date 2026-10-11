import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DomainError } from '../../common/domain-error';
import { ENV, type Env } from '../../config/env';
import { JobRegistry } from './job-registry';
import { MaintenanceService } from './maintenance.service';

/**
 * In-process scheduler: every JOBS_INTERVAL_MINUTES it runs every registered job sequentially,
 * isolating failures per job. It starts after application bootstrap (all modules have registered
 * their handlers by then) and is disabled in tests and when JOBS_ENABLED=false.
 *
 * Several API replicas may run this scheduler at once: MaintenanceService serialises each job
 * with a PostgreSQL advisory lock, so a replica that finds a job already running simply skips it.
 * The Redis-backed evolution is BullMQ repeatable jobs (one queue per job, workers on dedicated
 * processes, retries and dead-letter handling); the handlers registered on JobRegistry are reused as is.
 */
@Injectable()
export class JobsSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly registry: JobRegistry,
    private readonly maintenance: MaintenanceService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (!this.maintenance.schedulerEnabled) {
      this.logger.log('scheduler disabled (JOBS_ENABLED=false or test environment)');
      return;
    }
    const intervalMs = this.env.JOBS_INTERVAL_MINUTES * 60_000;
    this.timer = setInterval(() => void this.tick('scheduler'), intervalMs);
    this.timer.unref();
    this.logger.log(
      `scheduler started: ${this.registry.list().length} job(s) every ${this.env.JOBS_INTERVAL_MINUTES} min`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs every registered job once, sequentially. Never throws. */
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
          if (err instanceof DomainError && err.code === 'JOB_ALREADY_RUNNING') {
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
