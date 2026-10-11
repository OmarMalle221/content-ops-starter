import { Global, Module } from '@nestjs/common';
import { RiskService } from './risk.service';

@Global()
@Module({ providers: [RiskService], exports: [RiskService] })
export class RiskModule {}
