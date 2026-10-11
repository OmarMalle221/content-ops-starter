import { Module } from '@nestjs/common';
import { ReferenceDataService } from './reference-data.service';

@Module({ providers: [ReferenceDataService], exports: [ReferenceDataService] })
export class ReferenceModule {}
