import { randomUUID } from 'node:crypto';
import {
  PartnerCallError,
  ReferenceHttpClient,
  asObject,
  idempotencyKeyFor,
  requireString,
  verifyReferenceWebhook,
  type ReferenceHttpOptions,
  type SignedWebhook,
} from './reference-http';
import type {
  BusinessCheckInput,
  BusinessCheckResult,
  IdentityCheckInput,
  IdentityCheckResult,
  KycOutcomeStatus,
  KycProvider,
  ProviderKycDecision,
  SanctionsProvider,
  SanctionsScreeningInput,
  SanctionsScreeningResult,
} from './types';

/**
 * HTTP REFERENCE adapters for a generic KYC/KYB and sanctions-screening partner.
 *
 * They implement the documented reference contract of docs/architecture/PARTNER_ADAPTERS.md
 * against which a real, contracted provider would later be mapped. They are exercised by contract
 * tests against an in-process mock server ONLY: no factory returns them and no environment
 * variable selects them (createKycProvider / createSanctionsProvider refuse every non-sandbox
 * code), so the API can never call a partner.
 *
 * Results carry `simulated: false` but never a pass status: a provider APPROVED decision maps to
 * PENDING with `requiresManualReview: true` — a compliance officer always decides.
 */

export const REFERENCE_PROVIDER_CODE = 'reference';

export interface HttpReferenceKycOptions extends ReferenceHttpOptions {
  /** Secret used to verify decision webhooks (HMAC-SHA256). */
  webhookSecret: string;
  /** Accepted clock skew of webhook timestamps. Default 300 s. */
  webhookToleranceSeconds?: number;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

/** A provider decision, fetched (GET …/decision) or pushed (signed webhook). */
export interface ReferenceKycDecision {
  provider: string;
  providerRef: string;
  status: KycOutcomeStatus;
  providerDecision: ProviderKycDecision;
  reasons: string[];
  decidedAt: string | null;
  simulated: false;
  requiresManualReview: true;
  /** Webhook event id (webhooks only) — the idempotency key of the event. */
  eventId?: string;
}

const DECISIONS: readonly ProviderKycDecision[] = ['PENDING', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'];

/** Provider decision → platform status. Nothing ever maps to a pass: review is mandatory. */
export function mapKycDecision(decision: ProviderKycDecision): KycOutcomeStatus {
  return decision === 'REJECTED' ? 'REJECTED' : 'PENDING';
}

function parseDecision(value: unknown): ProviderKycDecision {
  if (typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)) {
    return value as ProviderKycDecision;
  }
  throw new PartnerCallError('BAD_RESPONSE', `Unknown provider decision: ${String(value).slice(0, 40)}`);
}

function parseReasons(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PartnerCallError('BAD_RESPONSE', 'Provider reasons must be a list');
  return value.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 300));
}

function parseOptionalDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new PartnerCallError('BAD_RESPONSE', 'Provider date is not ISO-8601');
  }
  return new Date(value).toISOString();
}

export class HttpReferenceKycProvider implements KycProvider {
  readonly code = REFERENCE_PROVIDER_CODE;
  readonly simulated = false;
  private readonly http: ReferenceHttpClient;
  private readonly now: () => Date;

  constructor(private readonly options: HttpReferenceKycOptions) {
    if (!options.webhookSecret || options.webhookSecret.length < 16) {
      throw new PartnerCallError('CONFIGURATION', 'Webhook secret missing or shorter than 16 characters');
    }
    this.http = new ReferenceHttpClient(options);
    this.now = options.now ?? (() => new Date());
  }

  async startIdentityCheck(input: IdentityCheckInput): Promise<IdentityCheckResult> {
    // `sandboxOutcome` is a sandbox-only knob: it is never forwarded to a partner.
    const applicant = {
      externalId: input.userId,
      kind: 'PERSON',
      firstName: input.firstName,
      lastName: input.lastName,
      country: input.country,
      ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
    };
    const check = {
      checkType: 'IDENTITY_DOCUMENT',
      documentType: input.documentType,
      issuingCountry: input.issuingCountry,
      ...(input.documentId ? { documentRef: input.documentId } : {}),
    };
    return this.runCheck('kyc-person', applicant, check);
  }

  async startBusinessCheck(input: BusinessCheckInput): Promise<BusinessCheckResult> {
    const applicant = {
      externalId: input.organizationId,
      kind: 'BUSINESS',
      legalName: input.legalName,
      registrationNumber: input.registrationNumber,
      registrationCountry: input.registrationCountry,
      businessType: input.businessType,
    };
    const check = {
      checkType: 'BUSINESS_REGISTRY',
      ...(input.registrationDocumentId ? { documentRef: input.registrationDocumentId } : {}),
    };
    return this.runCheck('kyc-business', applicant, check);
  }

  /** GET /v1/applicants/{id}/decision. */
  async fetchDecision(providerRef: string): Promise<ReferenceKycDecision> {
    const body = asObject(
      await this.http.get(`/v1/applicants/${encodeURIComponent(providerRef)}/decision`),
      'decision',
    );
    const applicantId = requireString(body, 'applicantId', 'decision');
    if (applicantId !== providerRef) {
      throw new PartnerCallError('BAD_RESPONSE', 'Decision does not belong to the requested applicant');
    }
    const providerDecision = parseDecision(body.decision);
    return {
      provider: this.code,
      providerRef,
      status: mapKycDecision(providerDecision),
      providerDecision,
      reasons: parseReasons(body.reasons),
      decidedAt: parseOptionalDate(body.decidedAt),
      simulated: false,
      requiresManualReview: true,
    };
  }

  /**
   * Verifies a decision webhook (HMAC-SHA256 over `${timestamp}.${rawBody}`, constant-time,
   * timestamp tolerance) and parses it. Callers persist `eventId` to drop duplicates.
   */
  parseDecisionWebhook(webhook: SignedWebhook): ReferenceKycDecision {
    verifyReferenceWebhook(this.options.webhookSecret, webhook, {
      toleranceSeconds: this.options.webhookToleranceSeconds,
      now: this.now(),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(webhook.rawBody);
    } catch {
      throw new PartnerCallError('BAD_RESPONSE', 'Webhook body is not valid JSON');
    }
    const body = asObject(parsed, 'webhook');
    if (body.type !== 'applicant.decision') {
      throw new PartnerCallError(
        'BAD_RESPONSE',
        `Unsupported webhook type: ${String(body.type).slice(0, 40)}`,
      );
    }
    const providerDecision = parseDecision(body.decision);
    return {
      provider: this.code,
      providerRef: requireString(body, 'applicantId', 'webhook'),
      status: mapKycDecision(providerDecision),
      providerDecision,
      reasons: parseReasons(body.reasons),
      decidedAt: parseOptionalDate(body.occurredAt),
      simulated: false,
      requiresManualReview: true,
      eventId: requireString(body, 'eventId', 'webhook'),
    };
  }

  /** create applicant → submit check → fetch the current decision (usually PENDING). */
  private async runCheck(
    operation: string,
    applicant: Record<string, unknown>,
    check: Record<string, unknown>,
  ): Promise<IdentityCheckResult> {
    const created = asObject(
      await this.http.post(
        '/v1/applicants',
        applicant,
        idempotencyKeyFor(`${operation}-applicant`, applicant),
      ),
      'applicant',
    );
    const applicantId = requireString(created, 'id', 'applicant');
    const submitted = asObject(
      await this.http.post(
        `/v1/applicants/${encodeURIComponent(applicantId)}/checks`,
        check,
        // One key per verification attempt (reused by the retries of this call only): a later
        // re-verification of the same applicant must reach the provider, not its cached answer.
        idempotencyKeyFor(`${operation}-check`, { applicantId, check, attempt: randomUUID() }),
      ),
      'check',
    );
    const checkId = requireString(submitted, 'checkId', 'check');
    const decision = await this.fetchDecision(applicantId);
    return {
      provider: this.code,
      providerRef: applicantId,
      status: decision.status,
      simulated: false,
      checkedAt: this.now().toISOString(),
      reasons: decision.reasons,
      raw: { applicantId, checkId, decision: decision.providerDecision, decidedAt: decision.decidedAt },
      providerDecision: decision.providerDecision,
      requiresManualReview: true,
    };
  }
}

export type HttpReferenceSanctionsOptions = ReferenceHttpOptions & { now?: () => Date };

export class HttpReferenceSanctionsProvider implements SanctionsProvider {
  readonly code = REFERENCE_PROVIDER_CODE;
  readonly simulated = false;
  private readonly http: ReferenceHttpClient;
  private readonly now: () => Date;

  constructor(options: HttpReferenceSanctionsOptions) {
    this.http = new ReferenceHttpClient(options);
    this.now = options.now ?? (() => new Date());
  }

  /** POST /v1/screenings. A potential match always requires a manual review. */
  async screen(input: SanctionsScreeningInput): Promise<SanctionsScreeningResult> {
    const payload = {
      fullName: input.fullName,
      ...(input.country ? { country: input.country } : {}),
      ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
    };
    const body = asObject(
      // One key per screening (reused by the retries of this call only): re-screening the same
      // person later must be screened against the current lists, not answered from a cache.
      await this.http.post(
        '/v1/screenings',
        payload,
        idempotencyKeyFor('sanctions-screening', { ...payload, screeningId: randomUUID() }),
      ),
      'screening',
    );
    const status = body.status;
    if (status !== 'CLEAR' && status !== 'POTENTIAL_MATCH') {
      throw new PartnerCallError('BAD_RESPONSE', `Unknown screening status: ${String(status).slice(0, 40)}`);
    }
    if (!Array.isArray(body.matches)) throw new PartnerCallError('BAD_RESPONSE', 'Screening matches missing');
    const matches = body.matches.map((m) => {
      const match = asObject(m, 'match');
      const score = match.score;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        throw new PartnerCallError('BAD_RESPONSE', 'Match score must be a number between 0 and 1');
      }
      return {
        list: requireString(match, 'list', 'match'),
        name: requireString(match, 'name', 'match'),
        score,
      };
    });
    if (status === 'POTENTIAL_MATCH' && matches.length === 0) {
      throw new PartnerCallError('BAD_RESPONSE', 'POTENTIAL_MATCH without any match');
    }
    return {
      provider: this.code,
      simulated: false,
      status,
      matches,
      screenedAt: this.now().toISOString(),
      providerRef: requireString(body, 'screeningId', 'screening'),
      requiresManualReview: status === 'POTENTIAL_MATCH',
    };
  }
}
