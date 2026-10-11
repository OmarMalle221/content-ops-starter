import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { FxQuotesService } from './fx-quotes.service';
import { TransfersAdminController } from './transfers-admin.controller';
import { TransfersJobsService } from './transfers-jobs.service';
import { TransfersSandboxController } from './transfers-sandbox.controller';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

/**
 * TransfersModule — Diaspora Transfer (Phase 4): simulated FX quotes, international transfers
 * funded from the organisation wallet, the simulated partner, compliance review and the
 * TRANSFER_PROCESSING maintenance job. Ledger, audit, notifications, risk, jobs and the event
 * bus come from global modules; organisations are imported explicitly.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [TransfersController, TransfersAdminController, TransfersSandboxController],
  providers: [FxQuotesService, TransfersService, TransfersJobsService],
  exports: [TransfersService, FxQuotesService],
})
export class TransfersModule {}
