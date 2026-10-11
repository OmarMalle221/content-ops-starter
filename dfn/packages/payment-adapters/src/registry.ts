import { SandboxPaymentProvider } from './sandbox.provider';
import type { PaymentProviderAdapter } from './types';

/**
 * Only the sandbox adapter is registered. Live adapters require a signed partner
 * agreement, regulatory review and a security assessment — see docs/compliance.
 */
export function createPaymentProvider(code: string | undefined): PaymentProviderAdapter {
  switch ((code ?? 'sandbox').toLowerCase()) {
    case 'sandbox':
    case 'sandbox_partner':
      return new SandboxPaymentProvider();
    default:
      throw new Error(`Payment provider "${code}" is not available. This build is sandbox-only.`);
  }
}
