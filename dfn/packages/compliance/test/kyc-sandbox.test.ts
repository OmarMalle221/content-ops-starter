import { describe, expect, it } from 'vitest';
import { SandboxKycProvider, SandboxSanctionsProvider, createKycProvider } from '../src';

describe('Sandbox KYC provider', () => {
  const provider = new SandboxKycProvider();
  const base = {
    userId: 'u1',
    firstName: 'Awa',
    lastName: 'Diop',
    country: 'SN',
    documentType: 'PASSPORT' as const,
    issuingCountry: 'SN',
  };

  it('always tags results as simulated and never returns a real "verified" status', async () => {
    const r = await provider.startIdentityCheck(base);
    expect(r.simulated).toBe(true);
    expect(r.status).toBe('SIMULATED_PASS');
    expect(['SIMULATED_PASS', 'SIMULATED_FAIL']).toContain(r.status);
  });

  it('simulates failures on demand', async () => {
    const r = await provider.startIdentityCheck({ ...base, sandboxOutcome: 'FAIL' });
    expect(r.status).toBe('SIMULATED_FAIL');
  });

  it('refuses unknown providers', () => {
    expect(() => createKycProvider('acme')).toThrow();
  });

  it('simulates sanctions screening', async () => {
    const s = new SandboxSanctionsProvider();
    expect((await s.screen({ fullName: 'Awa Diop' })).status).toBe('CLEAR_SIMULATED');
    expect((await s.screen({ fullName: 'Sanction Test' })).status).toBe('POTENTIAL_MATCH_SIMULATED');
  });
});
