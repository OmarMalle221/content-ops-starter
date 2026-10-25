import { Global, Module } from '@nestjs/common';
import { ReviewQueueService } from './review-queue.service';
import { ReviewSlaService } from './review-sla.service';
import { RiskService } from './risk.service';
import { StructuringFactsService } from './structuring-facts.service';

/**
 * Risk engine bridge (alerts with review SLA, structuring detection) and the compliance review
 * queue. Global: every feature module records alerts through RiskService. The REVIEW_SLA
 * maintenance job is registered on the (global) JobRegistry by ReviewSlaService.
 */
@Global()
@Module({
  providers: [RiskService, StructuringFactsService, ReviewQueueService, ReviewSlaService],
  exports: [RiskService, ReviewQueueService],
})
export class RiskModule {}
