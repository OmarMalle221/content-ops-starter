import { Module } from '@nestjs/common';
import { DdaAdminController } from './dda-admin.controller';
import { DdaRegistryService } from './dda-registry.service';
import { DdaService } from './dda.service';

/**
 * DdaModule — Diaspora Digital Asset research sandbox (Phase 5, P3). Strictly internal:
 * fictitious unit registry on the ledger (currency 'DDA', kind SIMULATED_ASSET), mint/transfer/
 * redeem simulators, simulated reserve, coverage dashboard, stress tester and traceability.
 * Admin-only (Permission.ADMIN_DDA). Ledger, audit and notifications come from global modules.
 * No public chain, no real money, no convertibility — see docs/architecture/DDA_SIMULATION.md.
 */
@Module({
  controllers: [DdaAdminController],
  providers: [DdaRegistryService, DdaService],
  exports: [DdaRegistryService, DdaService],
})
export class DdaModule {}
