/**
 * Provider-agnostic interfaces for identity (KYC), business (KYB) and sanctions screening.
 *
 * IMPORTANT: results produced by the sandbox adapter are *simulated*. They are tagged with
 * `simulated: true` and the statuses SIMULATED_PASS / SIMULATED_FAIL so that no UI can present
 * them as a real verification. A licensed provider adapter (Phase 3+) will return
 * provider-specific references that compliance staff can audit.
 */
export type KycOutcomeStatus = 'PENDING' | 'SIMULATED_PASS' | 'SIMULATED_FAIL' | 'REJECTED';

export interface IdentityCheckInput {
  userId: string;
  firstName: string;
  lastName: string;
  country: string;
  documentType: 'PASSPORT' | 'NATIONAL_ID' | 'DRIVER_LICENSE' | 'RESIDENCE_PERMIT';
  issuingCountry: string;
  dateOfBirth?: string;
  /** Reference to an encrypted document stored by the platform — never the raw bytes. */
  documentId?: string;
  sandboxOutcome?: 'PASS' | 'FAIL';
}

export interface IdentityCheckResult {
  provider: string;
  providerRef: string;
  status: KycOutcomeStatus;
  simulated: boolean;
  checkedAt: string;
  reasons: string[];
  raw: Record<string, unknown>;
}

export interface BusinessCheckInput {
  organizationId: string;
  legalName: string;
  registrationNumber: string;
  registrationCountry: string;
  businessType: string;
  registrationDocumentId?: string;
  sandboxOutcome?: 'PASS' | 'FAIL';
}

export type BusinessCheckResult = IdentityCheckResult;

export interface SanctionsScreeningInput {
  fullName: string;
  country?: string;
  dateOfBirth?: string;
}

export interface SanctionsScreeningResult {
  provider: string;
  simulated: boolean;
  status: 'CLEAR_SIMULATED' | 'POTENTIAL_MATCH_SIMULATED' | 'CLEAR' | 'POTENTIAL_MATCH';
  matches: Array<{ list: string; name: string; score: number }>;
  screenedAt: string;
}

export interface KycProvider {
  readonly code: string;
  readonly simulated: boolean;
  startIdentityCheck(input: IdentityCheckInput): Promise<IdentityCheckResult>;
  startBusinessCheck(input: BusinessCheckInput): Promise<BusinessCheckResult>;
}

export interface SanctionsProvider {
  readonly code: string;
  readonly simulated: boolean;
  screen(input: SanctionsScreeningInput): Promise<SanctionsScreeningResult>;
}
