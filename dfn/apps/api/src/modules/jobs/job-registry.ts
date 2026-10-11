import { Injectable, Logger } from '@nestjs/common';
import type { MaintenanceJobName } from '@dfn/database';

export interface JobResult {
  summary: Record<string, unknown>;
}
export type JobHandler = (context: { triggeredBy: string }) => Promise<JobResult>;

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
