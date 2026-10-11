import { Global, Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BeneficiariesController } from './beneficiaries.controller';
import { BeneficiariesService } from './beneficiaries.service';
import { ledgerProvider, LEDGER } from './ledger.provider';
import { SecurityPreferencesController } from './security-preferences.controller';
import { SecurityPreferencesService } from './security-preferences.service';
import { WalletsController } from './wallets.controller';
import { WalletsSandboxController } from './wallets-sandbox.controller';
import { WalletsService } from './wallets.service';

@Global()
@Module({
  imports: [OrganizationsModule],
  controllers: [
    WalletsController,
    WalletsSandboxController,
    BeneficiariesController,
    SecurityPreferencesController,
  ],
  providers: [ledgerProvider, WalletsService, BeneficiariesService, SecurityPreferencesService],
  exports: [LEDGER, WalletsService, BeneficiariesService, SecurityPreferencesService],
})
export class LedgerModule {}
