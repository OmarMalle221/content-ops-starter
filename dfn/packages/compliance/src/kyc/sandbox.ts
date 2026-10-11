import { createHash } from 'node:crypto';
import type {
  BusinessCheckInput,
  BusinessCheckResult,
  IdentityCheckInput,
  IdentityCheckResult,
  KycProvider,
  SanctionsProvider,
  SanctionsScreeningInput,
  SanctionsScreeningResult,
} from './types';

/**
 * Deterministic sandbox KYC/KYB adapter.
 *  - `sandboxOutcome: 'FAIL'` or a last name containing "FAIL" simulates a failed check.
 *  - everything else simulates a pass.
 * Every result is flagged `simulated: true`.
 */
export class SandboxKycProvider implements KycProvider {
  readonly code = 'sandbox';
  readonly simulated = true;

  async startIdentityCheck(input: IdentityCheckInput): Promise<IdentityCheckResult> {
    const fail = input.sandboxOutcome === 'FAIL' || /fail/i.test(input.lastName);
    const providerRef = `sbx_id_${createHash('sha256').update(`${input.userId}:${Date.now()}`).digest('hex').slice(0, 16)}`;
    return {
      provider: this.code,
      providerRef,
      status: fail ? 'SIMULATED_FAIL' : 'SIMULATED_PASS',
      simulated: true,
      checkedAt: new Date().toISOString(),
      reasons: fail
        ? ['SANDBOX: simulated document mismatch']
        : ['SANDBOX: no real verification was performed'],
      raw: {
        notice: 'Simulated result. No identity document was verified by a licensed provider.',
        documentType: input.documentType,
        issuingCountry: input.issuingCountry,
        documentId: input.documentId ?? null,
      },
    };
  }

  async startBusinessCheck(input: BusinessCheckInput): Promise<BusinessCheckResult> {
    const fail = input.sandboxOutcome === 'FAIL' || /fail/i.test(input.legalName);
    const providerRef = `sbx_biz_${createHash('sha256')
      .update(`${input.organizationId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16)}`;
    return {
      provider: this.code,
      providerRef,
      status: fail ? 'SIMULATED_FAIL' : 'SIMULATED_PASS',
      simulated: true,
      checkedAt: new Date().toISOString(),
      reasons: fail
        ? ['SANDBOX: simulated registry mismatch']
        : ['SANDBOX: no real registry lookup was performed'],
      raw: {
        notice: 'Simulated result. No business registry was queried.',
        registrationCountry: input.registrationCountry,
        registrationNumber: input.registrationNumber,
      },
    };
  }
}

export class SandboxSanctionsProvider implements SanctionsProvider {
  readonly code = 'sandbox';
  readonly simulated = true;

  async screen(input: SanctionsScreeningInput): Promise<SanctionsScreeningResult> {
    const match = /sanction/i.test(input.fullName);
    return {
      provider: this.code,
      simulated: true,
      status: match ? 'POTENTIAL_MATCH_SIMULATED' : 'CLEAR_SIMULATED',
      matches: match ? [{ list: 'SANDBOX_TEST_LIST', name: input.fullName, score: 0.91 }] : [],
      screenedAt: new Date().toISOString(),
    };
  }
}
