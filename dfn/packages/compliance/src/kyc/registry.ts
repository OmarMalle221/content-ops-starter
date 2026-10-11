import { SandboxKycProvider, SandboxSanctionsProvider } from './sandbox';
import type { KycProvider, SanctionsProvider } from './types';

/**
 * Factory. Only the sandbox providers exist today. Adding a licensed provider means
 * implementing the interfaces in ./types and registering it here behind an env flag,
 * together with the contractual / regulatory checklist in docs/compliance/KYC_KYB.md.
 */
export function createKycProvider(code: string | undefined): KycProvider {
  switch ((code ?? 'sandbox').toLowerCase()) {
    case 'sandbox':
      return new SandboxKycProvider();
    default:
      throw new Error(
        `KYC provider "${code}" is not implemented. Only "sandbox" is available in this build.`,
      );
  }
}

export function createSanctionsProvider(code: string | undefined): SanctionsProvider {
  switch ((code ?? 'sandbox').toLowerCase()) {
    case 'sandbox':
      return new SandboxSanctionsProvider();
    default:
      throw new Error(`Sanctions provider "${code}" is not implemented. Only "sandbox" is available.`);
  }
}
