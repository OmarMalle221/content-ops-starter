import { Module, type OnModuleInit } from '@nestjs/common';
import { GatesController } from './gates.controller';
import { ProviderActivationService } from './provider-activation.service';
import { RegulatoryGatesService } from './regulatory-gates.service';

/**
 * Regulatory gates register (R1–R10) and partner activation guard (phase 6).
 * Tracking only: no gate status ever switches DFN_MODE out of sandbox.
 *
 * At startup: (1) every configured provider code (KYC_PROVIDER, SANCTIONS_PROVIDER,
 * PAYMENT_PROVIDER, FX_PROVIDER, PAYOUT_PROVIDER) must be a sandbox code — otherwise the boot fails
 * fast with PROVIDER_NOT_ACTIVATABLE and the gates such a partner would require; (2) the ten gates
 * are (re)created in the register without touching their status, evidence or approvals.
 */
@Module({
  controllers: [GatesController],
  providers: [RegulatoryGatesService, ProviderActivationService],
  exports: [RegulatoryGatesService, ProviderActivationService],
})
export class GatesModule implements OnModuleInit {
  constructor(
    private readonly gates: RegulatoryGatesService,
    private readonly activation: ProviderActivationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.activation.assertConfiguredProviders();
    await this.gates.ensureDefaults({ syncDefinitions: true });
  }
}
