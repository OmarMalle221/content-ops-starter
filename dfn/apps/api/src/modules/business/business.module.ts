import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * BusinessModule — Diaspora Business (Phase 4): invoices, quotes, payments recording,
 * receivables, reports, CSV exports and commissions tracking. SANDBOX ONLY: every amount is
 * fictitious. Ledger, wallets, jobs, audit, notifications and the domain-event bus come from
 * global modules; OrganizationsModule provides tenant resolution.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [InvoicesController, QuotesController, ReportsController],
  providers: [InvoicesService, QuotesService, ReportsService],
  exports: [InvoicesService, QuotesService, ReportsService],
})
export class BusinessModule {}
