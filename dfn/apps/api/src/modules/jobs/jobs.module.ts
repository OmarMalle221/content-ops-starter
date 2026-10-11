import { Global, Module } from '@nestjs/common';
import { AccountDeletionAdminController, AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AnonymizationService } from './anonymization.service';
import { BuiltinJobsService } from './builtin-jobs.service';
import { JobRegistry } from './job-registry';
import { JobsAdminController } from './jobs-admin.controller';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { MaintenanceService } from './maintenance.service';

/**
 * JobsModule — scheduled maintenance (balance snapshots, reconciliation, expirations,
 * anonymisation), MaintenanceRun persistence, the admin jobs console and self-service account
 * deletion. `JobRegistry` stays exported and the module global: other modules register their
 * handlers on it (TRANSFER_PROCESSING, WEBHOOK_RETRY, INVOICE_OVERDUE).
 */
@Global()
@Module({
  controllers: [JobsAdminController, AccountDeletionController, AccountDeletionAdminController],
  providers: [
    JobRegistry,
    MaintenanceService,
    AnonymizationService,
    AccountDeletionService,
    BuiltinJobsService,
    JobsSchedulerService,
  ],
  exports: [JobRegistry, MaintenanceService, AnonymizationService, AccountDeletionService],
})
export class JobsModule {}
