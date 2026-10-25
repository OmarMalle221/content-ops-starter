import { Module } from '@nestjs/common';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesService } from './counterparties.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController, CounterpartiesController],
  providers: [OrganizationsService, CounterpartiesService],
  exports: [OrganizationsService, CounterpartiesService],
})
export class OrganizationsModule {}
