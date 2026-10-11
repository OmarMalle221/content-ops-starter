import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  GATES_TRACKING_DISCLAIMER,
  PROVIDER_ENV_VARS,
  PROVIDER_REQUIRED_GATES,
  ProviderKind,
  REGULATORY_GATES,
  isSandboxProviderCode,
  normalizeProviderCode,
  providerNotActivatableMessage,
} from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  ProviderKind.KYC,
  ProviderKind.SANCTIONS,
  ProviderKind.PAYMENT,
  ProviderKind.FX,
  ProviderKind.PAYOUT,
];

/** Env key of each provider kind (typed view of PROVIDER_ENV_VARS). */
const ENV_KEY: Record<ProviderKind, keyof Env> = {
  KYC: 'KYC_PROVIDER',
  SANCTIONS: 'SANCTIONS_PROVIDER',
  PAYMENT: 'PAYMENT_PROVIDER',
  FX: 'FX_PROVIDER',
  PAYOUT: 'PAYOUT_PROVIDER',
};

/** Reference adapters shipped for contract tests — never reachable from the environment. */
const REFERENCE_ADAPTERS: Record<ProviderKind, { name: string; package: string }> = {
  KYC: { name: 'HttpReferenceKycProvider', package: '@dfn/compliance' },
  SANCTIONS: { name: 'HttpReferenceSanctionsProvider', package: '@dfn/compliance' },
  PAYMENT: { name: '—', package: '@dfn/payment-adapters' },
  FX: { name: 'HttpReferenceFxRateProvider', package: '@dfn/payment-adapters' },
  PAYOUT: { name: 'HttpReferencePayoutProvider', package: '@dfn/payment-adapters' },
};

export interface RequiredGateStatus {
  code: string;
  title: string;
  /** Current register status, or UNKNOWN when the register could not be read. */
  status: string;
  satisfied: boolean;
}

export interface ProviderStatusDto {
  kind: ProviderKind;
  envVar: string;
  configuredCode: string;
  sandbox: boolean;
  /** Always false for a non-sandbox code in this build, whatever the gates say. */
  activatable: boolean;
  simulated: boolean;
  requiredGates: RequiredGateStatus[];
  requiredGatesSatisfied: number;
  referenceAdapter: { name: string; package: string; reachableFromEnv: false } | null;
}

/**
 * Partner activation guard. In this sandbox-only build (DFN_MODE=sandbox) every non-sandbox
 * provider code is refused with PROVIDER_NOT_ACTIVATABLE — even if every required regulatory gate
 * were SATISFIED: the register is tracking only, never a switch. The refusal lists the gates a
 * licensed partner of that kind would require, with their current status.
 */
@Injectable()
export class ProviderActivationService {
  private readonly logger = new Logger(ProviderActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Current status of each required gate (UNKNOWN if the register cannot be read). */
  async requiredGates(kind: ProviderKind): Promise<RequiredGateStatus[]> {
    const codes = PROVIDER_REQUIRED_GATES[kind];
    let statuses: Map<string, string> | null = null;
    try {
      const rows = await this.prisma.regulatoryGate.findMany({
        where: { code: { in: [...codes] } },
        select: { code: true, status: true },
      });
      statuses = new Map(rows.map((r) => [r.code, r.status]));
    } catch (e) {
      this.logger.warn(`regulatory gates register unreadable: ${(e as Error).message}`);
    }
    return codes.map((code) => {
      // A gate missing from a readable register has simply not been started.
      const status = statuses ? (statuses.get(code) ?? 'NOT_STARTED') : 'UNKNOWN';
      return {
        code,
        title: REGULATORY_GATES.find((g) => g.code === code)?.title ?? code,
        status,
        satisfied: status === 'SATISFIED',
      };
    });
  }

  /**
   * Refuses any non-sandbox provider code. Returns quietly for sandbox codes; there is no code
   * path in which a non-sandbox code is accepted while DFN_MODE is sandbox.
   */
  async assertProviderActivatable(kind: ProviderKind, code: string | undefined | null): Promise<void> {
    if (isSandboxProviderCode(kind, code)) return;
    const requiredGates = await this.requiredGates(kind);
    throw new DomainError(
      ErrorCode.PROVIDER_NOT_ACTIVATABLE,
      providerNotActivatableMessage(kind, code),
      HttpStatus.UNPROCESSABLE_ENTITY,
      {
        kind,
        envVar: PROVIDER_ENV_VARS[kind],
        providerCode: normalizeProviderCode(code),
        mode: 'sandbox',
        reason: 'SANDBOX_ONLY_BUILD',
        requiredGates,
        allRequiredGatesSatisfied: requiredGates.every((g) => g.satisfied),
        disclaimer: GATES_TRACKING_DISCLAIMER,
      },
    );
  }

  /** Startup check of KYC_PROVIDER, SANCTIONS_PROVIDER, PAYMENT_PROVIDER, FX_PROVIDER, PAYOUT_PROVIDER. */
  async assertConfiguredProviders(env: Env = this.env): Promise<void> {
    for (const kind of PROVIDER_KINDS) {
      await this.assertProviderActivatable(kind, env[ENV_KEY[kind]] as string | undefined);
    }
  }

  /** GET /v1/admin/gates/providers — configured providers, sandbox status and required gates. */
  async listProviders() {
    const providers: ProviderStatusDto[] = [];
    for (const kind of PROVIDER_KINDS) {
      const configuredCode = normalizeProviderCode(this.env[ENV_KEY[kind]] as string | undefined);
      const sandbox = isSandboxProviderCode(kind, configuredCode);
      const requiredGates = await this.requiredGates(kind);
      const reference = REFERENCE_ADAPTERS[kind];
      providers.push({
        kind,
        envVar: PROVIDER_ENV_VARS[kind],
        configuredCode,
        sandbox,
        activatable: sandbox,
        simulated: true,
        requiredGates,
        requiredGatesSatisfied: requiredGates.filter((g) => g.satisfied).length,
        referenceAdapter:
          reference.name === '—'
            ? null
            : { name: reference.name, package: reference.package, reachableFromEnv: false },
      });
    }
    return {
      mode: 'sandbox' as const,
      trackingOnly: true as const,
      disclaimer: GATES_TRACKING_DISCLAIMER,
      providers,
    };
  }
}
