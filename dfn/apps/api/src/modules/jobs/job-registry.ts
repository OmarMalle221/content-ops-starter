import { Injectable, Logger } from '@nestjs/common';
import type { MaintenanceJobName } from '@dfn/database';

export interface JobResult {
  summary: Record<string, unknown>;
}

/**
 * What a handler receives. `triggeredBy` has always been there; the other fields are optional so
 * that handlers written against the original `{ triggeredBy }` contract keep compiling.
 */
export interface JobContext {
  /** "scheduler", "scheduler:bullmq", "manual:<userId>"… — recorded on the MaintenanceRun. */
  triggeredBy: string;
  /**
   * Aborted when this replica loses the job lease (heartbeat refused: lease taken over after
   * expiry, or renewal impossible for a whole lease period). Long handlers should check it between
   * batches and stop early; the run is recorded FAILED either way, and the next run resumes.
   */
  signal?: AbortSignal;
  /** Id of the MaintenanceRun row of this execution. */
  runId?: string;
}

export type JobHandler = (context: JobContext) => Promise<JobResult>;

/**
 * Feature modules register their maintenance handlers here (onModuleInit); the scheduler and
 * the admin "run now" endpoint execute them and persist MaintenanceRun rows.
 */
@Injectable()
export class JobRegistry {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly handlers = new Map<MaintenanceJobName, JobHandler>();

  register(name: MaintenanceJobName, handler: JobHandler) {
    if (this.handlers.has(name)) this.logger.warn(`job ${name} registered twice — overriding`);
    this.handlers.set(name, handler);
  }

  get(name: MaintenanceJobName): JobHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: MaintenanceJobName): boolean {
    return this.handlers.has(name);
  }

  list(): MaintenanceJobName[] {
    return [...this.handlers.keys()];
  }
}
