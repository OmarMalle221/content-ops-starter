import { describe, expect, it } from 'vitest';
import { SandboxPaymentProvider, createPaymentProvider, signPayload, verifySignature } from '../src';

describe('SandboxPaymentProvider', () => {
  const provider = new SandboxPaymentProvider();

  it('issues clearly fictitious funding instructions', async () => {
    const fi = await provider.createFundingInstructions({
      transactionId: 't1',
      transactionReference: 'DFN-0001',
      amountMinor: 100_000n,
      currencyCode: 'CAD',
      payerName: 'Awa',
      method: 'BANK_TRANSFER_SIMULATED',
    });
    expect(fi.mode).toBe('SANDBOX');
    expect(fi.reference.startsWith('SBXF-DFN-0001')).toBe(true);
    expect(fi.instructions.notice).toMatch(/fictives|Simulated/);
    expect(fi.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('derives deterministic idempotency keys for partner events', async () => {
    const a = await provider.simulateFundingEvent({ fundingReference: 'SBXF-1', outcome: 'CONFIRMED' });
    const b = await provider.simulateFundingEvent({ fundingReference: 'SBXF-1', outcome: 'CONFIRMED' });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.type).toBe('funding.confirmed');
  });

  it('refuses non-sandbox providers', () => {
    expect(() => createPaymentProvider('stripe')).toThrow(/sandbox-only/);
    expect(createPaymentProvider(undefined).mode).toBe('SANDBOX');
  });

  it('signs and verifies webhook payloads', () => {
    const sig = signPayload('secret', '123', '{"a":1}');
    expect(verifySignature('secret', '123', '{"a":1}', sig)).toBe(true);
    expect(verifySignature('secret', '123', '{"a":2}', sig)).toBe(false);
    expect(verifySignature('secret', '123', '{"a":1}', 'ff')).toBe(false);
  });
});
