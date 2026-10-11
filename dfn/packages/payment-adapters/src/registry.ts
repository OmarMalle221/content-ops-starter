import { ProviderKind, assertSandboxProviderCode } from '@dfn/shared';
import { SandboxPayoutProvider, type PayoutProvider } from './payout';
import { SandboxPaymentProvider } from './sandbox.provider';
import type { PaymentProviderAdapter } from './types';

/**
 * Only the sandbox adapters are registered. Every other code — "reference" included — throws
 * ProviderNotActivatableError (PROVIDER_NOT_ACTIVATABLE, message says "sandbox-only") naming the
 * regulatory gates a licensed partner would require. Live adapters require a signed partner
 * agreement, regulatory review and a security assessment — see docs/architecture/PARTNER_ADAPTERS.md.
 * The HTTP reference adapters are constructed explicitly by contract tests, never from the env.
 */
export function createPaymentProvider(code: string | undefined): PaymentProviderAdapter {
  assertSandboxProviderCode(ProviderKind.PAYMENT, code);
  return new SandboxPaymentProvider();
}

/** PAYOUT_PROVIDER — sandbox only, same policy as createPaymentProvider. */
export function createPayoutProvider(code: string | undefined): PayoutProvider {
  assertSandboxProviderCode(ProviderKind.PAYOUT, code);
  return new SandboxPayoutProvider();
}
