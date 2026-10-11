import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CURRENCIES } from '@dfn/shared';
import { LedgerService, platformFeesCode, providerSettlementCode } from '@dfn/financial-ledger';
import { SANDBOX_PROVIDER_CODE } from '@dfn/payment-adapters';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';

/** Idempotently seeds currencies, the sandbox provider and platform ledger accounts on boot. */
@Injectable()
export class ReferenceDataService implements OnModuleInit {
  private readonly logger = new Logger(ReferenceDataService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit() {
    await this.ensure();
  }

  async ensure() {
    const ledger = new LedgerService(this.prisma);
    for (const c of Object.values(CURRENCIES)) {
      await this.prisma.currency.upsert({
        where: { code: c.code },
        update: { name: c.name, exponent: c.exponent, symbol: c.symbol },
        create: { code: c.code, name: c.name, exponent: c.exponent, symbol: c.symbol },
      });
    }
    await this.prisma.paymentProvider.upsert({
      where: { code: SANDBOX_PROVIDER_CODE },
      update: { isActive: true },
      create: {
        code: SANDBOX_PROVIDER_CODE,
        name: 'Sandbox partner (simulated — no real funds)',
        mode: 'SANDBOX',
        config: { notice: 'Simulated licensed partner. Never moves money.' },
      },
    });
    for (const code of Object.keys(CURRENCIES)) {
      await ledger.ensureAccount({
        code: providerSettlementCode(SANDBOX_PROVIDER_CODE, code),
        name: `Sandbox partner settlement (${code})`,
        type: 'ASSET',
        normalBalance: 'DEBIT',
        currencyCode: code,
        ownerType: 'PROVIDER',
        allowNegative: true,
      });
      await ledger.ensureAccount({
        code: platformFeesCode(code),
        name: `Platform fees (${code})`,
        type: 'REVENUE',
        normalBalance: 'CREDIT',
        currencyCode: code,
        ownerType: 'PLATFORM',
      });
    }
    this.logger.log(`reference data ready (mode=${this.env.DFN_MODE})`);
  }
}
