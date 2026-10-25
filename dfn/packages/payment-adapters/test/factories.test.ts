import { describe, expect, it } from 'vitest';
import { ErrorCode, PROVIDER_REQUIRED_GATES, ProviderNotActivatableError } from '@dfn/shared';
import {
  SandboxFxRateProvider,
  SandboxPaymentProvider,
  SandboxPayoutProvider,
  createFxRateProvider,
  createPaymentProvider,
  createPayoutProvider,
} from '../src';

const FACTORIES = [
  { kind: 'PAYMENT', create: createPaymentProvider, sandbox: SandboxPaymentProvider },
  { kind: 'PAYOUT', create: createPayoutProvider, sandbox: SandboxPayoutProvider },
  { kind: 'FX', create: createFxRateProvider, sandbox: SandboxFxRateProvider },
] as const;

describe('provider factories refuse every non-sandbox code', () => {
  for (const { kind, create, sandbox } of FACTORIES) {
    it.each(['reference', 'REFERENCE', 'live', 'licensed-partner', 'http'])(`${kind}: refuses %s`, (code) => {
      let caught: unknown;
      try {
        create(code);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProviderNotActivatableError);
      const err = caught as ProviderNotActivatableError;
      expect(err.code).toBe(ErrorCode.PROVIDER_NOT_ACTIVATABLE);
      expect(err.kind).toBe(kind);
      expect(err.requiredGates).toEqual(PROVIDER_REQUIRED_GATES[kind]);
      expect(err.message).toMatch(/sandbox-only/);
      expect(err.message).toContain(PROVIDER_REQUIRED_GATES[kind].join(', '));
    });

    it(`${kind}: builds the sandbox provider for sandbox / unset codes`, () => {
      for (const code of ['sandbox', ' Sandbox ', undefined, '']) {
        expect(create(code)).toBeInstanceOf(sandbox);
      }
    });
  }

  it('keeps the historical sandbox_partner alias for payments only', () => {
    expect(createPaymentProvider('sandbox_partner')).toBeInstanceOf(SandboxPaymentProvider);
    expect(() => createPayoutProvider('sandbox_partner')).toThrow(ProviderNotActivatableError);
  });

  it('lists the gates of each kind', () => {
    expect(PROVIDER_REQUIRED_GATES.PAYMENT).toEqual(['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']);
    expect(PROVIDER_REQUIRED_GATES.PAYOUT).toEqual(PROVIDER_REQUIRED_GATES.PAYMENT);
    expect(PROVIDER_REQUIRED_GATES.FX).toEqual(['R1', 'R3', 'R4', 'R6', 'R8']);
  });
});
