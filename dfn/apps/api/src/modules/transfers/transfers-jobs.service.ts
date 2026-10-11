import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../jobs/job-registry';
import { TransfersService } from './transfers.service';

/** Registers the TRANSFER_PROCESSING maintenance job (sandbox auto-settlement + quote expiry). */
@Injectable()
export class TransfersJobsService implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly transfers: TransfersService,
  ) {}

  onModuleInit() {
    this.registry.register('TRANSFER_PROCESSING', (ctx) => this.transfers.processingJob(ctx.triggeredBy));
  }
}
