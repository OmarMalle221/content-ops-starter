import { Global, Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { MilestonesService } from './milestones.service';
import { TransactionAccessService } from './transaction-access.service';
import { TransactionEventsService } from './transaction-events.service';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Global()
@Module({
  imports: [OrganizationsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, MilestonesService, TransactionAccessService, TransactionEventsService],
  exports: [TransactionsService, MilestonesService, TransactionAccessService, TransactionEventsService],
})
export class TransactionsModule {}
