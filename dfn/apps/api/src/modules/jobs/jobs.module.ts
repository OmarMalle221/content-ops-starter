import { Global, Module } from '@nestjs/common';
import { JobRegistry } from './job-registry';

/**
 * JobsModule — skeleton registered by the platform integrator. The jobs agent adds the
 * scheduler, MaintenanceRun persistence, built-in handlers and admin endpoints.
 * Keep `JobRegistry` exported and the module global: other modules register handlers on it.
 */
@Global()
@Module({ controllers: [], providers: [JobRegistry], exports: [JobRegistry] })
export class JobsModule {}
