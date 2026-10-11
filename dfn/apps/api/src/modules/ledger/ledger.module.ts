import { Global, Module } from '@nestjs/common';
import { ledgerProvider, LEDGER } from './ledger.provider';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Global()
@Module({
  controllers: [WalletsController],
  providers: [ledgerProvider, WalletsService],
  exports: [LEDGER, WalletsService],
})
export class LedgerModule {}
