import { Global, Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Global()
@Module({ providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
