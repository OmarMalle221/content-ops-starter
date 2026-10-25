import { z } from 'zod';
import { RegulatoryGateStatus } from '../enums';
import { ErrorCode } from '../errors';
import { defineStateMachine } from '../state-machines/machine';
import { mfaProofShape } from './passkeys';

/**
 * Phase 6 — regulatory gates register (R1–R10) and partner activation policy.
 *
 * The register is a TRACKING tool: no gate status, not even all ten gates SATISFIED, switches the
 * platform out of sandbox. DFN_MODE stays "sandbox" in this code base and every provider factory
 * keeps refusing non-sandbox codes.
 */

/** Gate codes R1..R10 (case-insensitive on input, normalised to upper case). */
export const gateCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^R(10|[1-9])$/, 'Unknown regulatory gate code');

const noteSchema = z.string().trim().min(3, 'A note of at least 3 characters is required').max(2000);
/** Reference of the evidence (archive id, document path, ticket…). Text only: no file upload. */
const evidenceRefSchema = z
  .string()
  .trim()
  .min(3, 'An evidence reference of at least 3 characters is required')
  .max(500);

/** POST /v1/admin/gates/:code/progress — start (or document) the work on a gate. */
export const gateProgressSchema = z
  .object({
    status: z.literal(RegulatoryGateStatus.IN_PROGRESS),
    note: noteSchema,
    evidenceRef: evidenceRefSchema.optional(),
  })
  .strict();
export type GateProgressInput = z.infer<typeof gateProgressSchema>;

/**
 * POST /v1/admin/gates/:code/approve — first approval (→ PENDING_SECOND_APPROVAL) or second
 * approval by a different ADMIN (→ SATISFIED). Note and evidence reference are mandatory.
 */
export const gateApproveSchema = z
  .object({
    note: noteSchema,
    evidenceRef: evidenceRefSchema,
    /** Fresh second factor, required when the approving ADMIN has MFA or a passkey. */
    ...mfaProofShape,
  })
  .strict();
export type GateApproveInput = z.infer<typeof gateApproveSchema>;

/** POST /v1/admin/gates/:code/revoke — back to REVOKED, approvals cleared. */
export const gateRevokeSchema = z
  .object({
    note: noteSchema,
    /** Fresh second factor, required when the revoking ADMIN has MFA or a passkey. */
    ...mfaProofShape,
  })
  .strict();
export type GateRevokeInput = z.infer<typeof gateRevokeSchema>;

/** Server-driven actions a gate DTO may offer to the viewer. */
export const GateAction = {
  PROGRESS: 'PROGRESS',
  APPROVE: 'APPROVE',
  REVOKE: 'REVOKE',
} as const;
export type GateAction = (typeof GateAction)[keyof typeof GateAction];

/** Event actions recorded in RegulatoryGateEvent.action. */
export const GateEventAction = {
  PROGRESS: 'PROGRESS',
  FIRST_APPROVAL: 'FIRST_APPROVAL',
  SECOND_APPROVAL: 'SECOND_APPROVAL',
  REVOKE: 'REVOKE',
} as const;
export type GateEventAction = (typeof GateEventAction)[keyof typeof GateEventAction];

/**
 * Gate lifecycle. IN_PROGRESS → IN_PROGRESS is allowed to document progress (new note / evidence).
 * Approvals require the gate to be IN_PROGRESS first; SATISFIED needs two distinct approvers.
 */
export const regulatoryGateMachine = defineStateMachine<RegulatoryGateStatus>('RegulatoryGate', {
  NOT_STARTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['IN_PROGRESS', 'PENDING_SECOND_APPROVAL', 'REVOKED'],
  PENDING_SECOND_APPROVAL: ['SATISFIED', 'REVOKED'],
  SATISFIED: ['REVOKED'],
  REVOKED: ['IN_PROGRESS'],
});

/** Shown with every gate DTO and on every gates screen. */
export const GATES_TRACKING_DISCLAIMER = {
  fr: 'Suivi uniquement — aucun statut ne permet d’activer des fonds réels ; DFN_MODE reste sandbox.',
  en: 'Tracking only — no status can activate real funds; DFN_MODE stays sandbox.',
} as const;

// ── Partner activation policy ────────────────────────────────────────────────────────────────

/** Kinds of external partner a provider code selects (env KYC_PROVIDER, …, PAYOUT_PROVIDER). */
export const ProviderKind = {
  KYC: 'KYC',
  SANCTIONS: 'SANCTIONS',
  PAYMENT: 'PAYMENT',
  FX: 'FX',
  PAYOUT: 'PAYOUT',
} as const;
export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

/** Environment variable that selects each provider kind. */
export const PROVIDER_ENV_VARS: Readonly<Record<ProviderKind, string>> = {
  KYC: 'KYC_PROVIDER',
  SANCTIONS: 'SANCTIONS_PROVIDER',
  PAYMENT: 'PAYMENT_PROVIDER',
  FX: 'FX_PROVIDER',
  PAYOUT: 'PAYOUT_PROVIDER',
};

/**
 * Gates that would have to be SATISFIED before a licensed partner of this kind could even be
 * considered. Informative only: in this build no gate status makes a non-sandbox code activatable.
 */
export const PROVIDER_REQUIRED_GATES: Readonly<Record<ProviderKind, readonly string[]>> = {
  KYC: ['R1', 'R2', 'R7', 'R8'],
  SANCTIONS: ['R1', 'R2', 'R7', 'R8'],
  PAYMENT: ['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'],
  PAYOUT: ['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'],
  FX: ['R1', 'R3', 'R4', 'R6', 'R8'],
};

/** Provider codes accepted by the factories (lower-cased). Anything else is refused. */
export const SANDBOX_PROVIDER_CODES: Readonly<Record<ProviderKind, readonly string[]>> = {
  KYC: ['sandbox'],
  SANCTIONS: ['sandbox'],
  PAYMENT: ['sandbox', 'sandbox_partner'],
  FX: ['sandbox'],
  PAYOUT: ['sandbox'],
};

/** Normalised provider code: undefined / blank → "sandbox", otherwise trimmed lower case. */
export function normalizeProviderCode(code: string | undefined | null): string {
  const c = (code ?? '').trim().toLowerCase();
  return c === '' ? 'sandbox' : c;
}

export function isSandboxProviderCode(kind: ProviderKind, code: string | undefined | null): boolean {
  return SANDBOX_PROVIDER_CODES[kind].includes(normalizeProviderCode(code));
}

export function providerNotActivatableMessage(kind: ProviderKind, code: string | undefined | null): string {
  return (
    `[${ErrorCode.PROVIDER_NOT_ACTIVATABLE}] ${kind} provider "${code ?? ''}" (${PROVIDER_ENV_VARS[kind]}) ` +
    'cannot be activated: this build is sandbox-only (DFN_MODE=sandbox). Activating a licensed partner ' +
    `would require the regulatory gates ${PROVIDER_REQUIRED_GATES[kind].join(', ')}, a legal review, a ` +
    'signed partner contract and a reviewed code change — see docs/architecture/PARTNER_ADAPTERS.md.'
  );
}

/**
 * Thrown by every provider factory for a non-sandbox code. Reference adapters exist for contract
 * tests only and are never reachable through a factory or an environment variable.
 */
export class ProviderNotActivatableError extends Error {
  readonly code = ErrorCode.PROVIDER_NOT_ACTIVATABLE;
  readonly requiredGates: readonly string[];

  constructor(
    readonly kind: ProviderKind,
    readonly providerCode: string,
  ) {
    super(providerNotActivatableMessage(kind, providerCode));
    this.name = 'ProviderNotActivatableError';
    this.requiredGates = PROVIDER_REQUIRED_GATES[kind];
  }
}

/** Throws ProviderNotActivatableError unless `code` is a sandbox code of `kind`. */
export function assertSandboxProviderCode(kind: ProviderKind, code: string | undefined | null): void {
  if (!isSandboxProviderCode(kind, code)) throw new ProviderNotActivatableError(kind, code ?? '');
}
