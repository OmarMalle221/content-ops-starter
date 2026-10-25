/**
 * Provider-agnostic interfaces for identity (KYC), business (KYB) and sanctions screening.
 *
 * IMPORTANT: results produced by the sandbox adapter are *simulated*. They are tagged with
 * `simulated: true` and the statuses SIMULATED_PASS / SIMULATED_FAIL so that no UI can present
 * them as a real verification. The HTTP reference adapters (./http-reference.ts, contract tests
 * only — never reachable through the factories) return `simulated: false` and never produce a
 * pass status: a provider approval maps to PENDING with `requiresManualReview: true`.
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

/** Decision as reported by a (reference) provider, before any manual compliance review. */
export type ProviderKycDecision = 'PENDING' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED';

export interface IdentityCheckResult {
  provider: string;
  providerRef: string;
  status: KycOutcomeStatus;
  simulated: boolean;
  checkedAt: string;
  reasons: string[];
  raw: Record<string, unknown>;
  /** Raw provider decision (reference adapters only). APPROVED still maps to status PENDING. */
  providerDecision?: ProviderKycDecision;
  /** True when a compliance officer must confirm the outcome before it has any effect. */
  requiresManualReview?: boolean;
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
  /** Provider screening reference (reference adapters only). */
  providerRef?: string;
  /** True when a compliance officer must review the screening (every potential match). */
  requiresManualReview?: boolean;
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
