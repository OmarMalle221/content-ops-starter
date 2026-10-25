import { ProviderKind, assertSandboxProviderCode } from '@dfn/shared';
import { SandboxKycProvider, SandboxSanctionsProvider } from './sandbox';
import type { KycProvider, SanctionsProvider } from './types';

/**
 * Factories selected by KYC_PROVIDER / SANCTIONS_PROVIDER. Only the sandbox providers can be
 * built: every other code — "reference" included — throws ProviderNotActivatableError
 * (PROVIDER_NOT_ACTIVATABLE) naming the regulatory gates a licensed partner would require.
 *
 * The HTTP reference adapters (./http-reference.ts) are deliberately NOT registered here: they are
 * constructed explicitly by contract tests and never from the environment. Wiring a contracted
 * provider is a reviewed code change after legal review and the gates of
 * docs/compliance/AUTHORIZATIONS_CHECKLIST.md — see docs/architecture/PARTNER_ADAPTERS.md.
 */
export function createKycProvider(code: string | undefined): KycProvider {
  assertSandboxProviderCode(ProviderKind.KYC, code);
  return new SandboxKycProvider();
}

export function createSanctionsProvider(code: string | undefined): SanctionsProvider {
  assertSandboxProviderCode(ProviderKind.SANCTIONS, code);
  return new SandboxSanctionsProvider();
}
