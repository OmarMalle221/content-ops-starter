/**
 * Phase 6 — passkeys (WebAuthn) and MFA step-up request schemas (zod). Owned by the passkeys
 * work area.
 *
 * Step-up design (ADR-0009): an endpoint that needs a fresh second factor accepts, in its own
 * body, EITHER `mfaCode` (6-digit TOTP code or single-use recovery code) OR `passkeyAssertion`
 * (a WebAuthn assertion answering a STEP_UP challenge issued to the same session by
 * POST /v1/auth/passkeys/step-up/options for that operation and resource — phase 7). There is no
 * intermediate step-up token.
 */
import { z } from 'zod';
import { StepUpOperation } from '../enums';
import { emailSchema } from './common';

/** base64url (RFC 4648 §5), optional padding tolerated, bounded length. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Expected a base64url string');

const clientExtensionResultsSchema = z.record(z.unknown()).default({});
const authenticatorAttachmentSchema = z.enum(['platform', 'cross-platform']).optional();

/** RegistrationResponseJSON as produced by @simplewebauthn/browser `startRegistration()`. */
export const webAuthnRegistrationResponseSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url(8192),
    attestationObject: base64url(65_536),
    authenticatorData: base64url(65_536).optional(),
    transports: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url(8192).optional(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema,
  clientExtensionResults: clientExtensionResultsSchema,
});
export type WebAuthnRegistrationResponseInput = z.infer<typeof webAuthnRegistrationResponseSchema>;

/** AuthenticationResponseJSON as produced by @simplewebauthn/browser `startAuthentication()`. */
export const webAuthnAssertionSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url(8192),
    authenticatorData: base64url(8192),
    signature: base64url(4096),
    userHandle: base64url(1024).nullish(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema,
  clientExtensionResults: clientExtensionResultsSchema,
});
export type WebAuthnAssertionInput = z.infer<typeof webAuthnAssertionSchema>;

// ───────────────────────────── MFA codes ─────────────────────────────

export const TOTP_CODE_PATTERN = /^\d{6}$/;
/** Canonical recovery code: 10 base32 characters shown as XXXX-XXXX-XX. */
export const RECOVERY_CODE_PATTERN = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{2}$/;
/** What a user may type: case-insensitive, dashes or spaces optional. */
const RECOVERY_CODE_INPUT_PATTERN = /^[A-Za-z2-7]{4}[\s-]?[A-Za-z2-7]{4}[\s-]?[A-Za-z2-7]{2}$/;

export const RECOVERY_CODE_COUNT = 10;

export function isTotpCode(value: string): boolean {
  return TOTP_CODE_PATTERN.test(value.trim());
}

/** Canonical XXXX-XXXX-XX form of a typed recovery code, or null when it cannot be one. */
export function normalizeRecoveryCode(value: string): string | null {
  const trimmed = value.trim();
  if (!RECOVERY_CODE_INPUT_PATTERN.test(trimmed)) return null;
  const raw = trimmed.replace(/[\s-]/g, '').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
}

/** A second-factor code: 6-digit TOTP code or a recovery code (accepted wherever TOTP is). */
export const mfaCodeSchema = z
  .string()
  .trim()
  .max(32)
  .refine((v) => TOTP_CODE_PATTERN.test(v) || RECOVERY_CODE_INPUT_PATTERN.test(v), {
    message: 'Expected a 6-digit code or a recovery code (XXXX-XXXX-XX)',
  });

/**
 * Fields carrying a fresh MFA proof. Spread into the body schema of every step-up protected
 * endpoint (transfer authorisation, lowering security preferences, passkey revocation, recovery
 * code regeneration). Both are optional at the schema level: the server decides whether a proof
 * is required for this user and this operation.
 */
export const mfaProofShape = {
  mfaCode: mfaCodeSchema.optional(),
  passkeyAssertion: webAuthnAssertionSchema.optional(),
};
export const mfaProofSchema = z.object(mfaProofShape);
export type MfaProofInput = z.infer<typeof mfaProofSchema>;

// ───────────────────────────── Passkeys ─────────────────────────────

export const passkeyNameSchema = z.string().trim().min(1).max(60);

/**
 * POST /v1/auth/passkeys/registration/options — a passkey is a durable, MFA-grade way in, so
 * adding one needs a fresh proof on top of the session: a second factor (`mfaCode` or
 * `passkeyAssertion`) when MFA is enabled, otherwise the current password (or an assertion of an
 * existing passkey). A stolen session cookie alone cannot plant a permanent credential.
 */
export const passkeyRegistrationOptionsSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    ...mfaProofShape,
    currentPassword: z.string().min(1).max(128).optional(),
  }),
);
export type PasskeyRegistrationOptionsInput = z.infer<typeof passkeyRegistrationOptionsSchema>;

/** POST /v1/auth/passkeys/registration/verify */
export const passkeyRegistrationVerifySchema = z.object({
  name: passkeyNameSchema,
  response: webAuthnRegistrationResponseSchema,
});
export type PasskeyRegistrationVerifyInput = z.infer<typeof passkeyRegistrationVerifySchema>;

/** PATCH /v1/auth/passkeys/:id */
export const passkeyRenameSchema = z.object({ name: passkeyNameSchema });
export type PasskeyRenameInput = z.infer<typeof passkeyRenameSchema>;

/**
 * POST /v1/auth/passkeys/authentication/options (public). The e-mail is accepted for client
 * convenience but never used: the response is identical whether or not the account exists or has
 * passkeys (discoverable credentials, empty allowCredentials).
 */
export const passkeyAuthenticationOptionsSchema = z.preprocess(
  (v) => v ?? {},
  z.object({ email: emailSchema.optional() }),
);
export type PasskeyAuthenticationOptionsInput = z.infer<typeof passkeyAuthenticationOptionsSchema>;

/** POST /v1/auth/passkeys/authentication/verify (public). */
export const passkeyAuthenticationVerifySchema = z.object({ response: webAuthnAssertionSchema });
export type PasskeyAuthenticationVerifyInput = z.infer<typeof passkeyAuthenticationVerifySchema>;

/**
 * Resource a step-up proof is bound to: a UUID (transfer, passkey) or a short code (gate code,
 * managed key id). Starts with a letter or digit, so it can never be the "-" placeholder of
 * "no resource" in the stored binding.
 */
export const stepUpResourceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'Expected a resource id of at most 64 characters [A-Za-z0-9_-]');

/**
 * POST /v1/auth/passkeys/step-up/options — the STEP_UP challenge is bound to the operation (and,
 * when relevant, the resource) the assertion will authorise. The protected endpoint refuses an
 * assertion answering a challenge issued for anything else (403 STEP_UP_OPERATION_MISMATCH).
 */
export const passkeyStepUpOptionsSchema = z
  .object({
    operation: z.nativeEnum(StepUpOperation),
    resourceId: stepUpResourceIdSchema.optional(),
  })
  .strict();
export type PasskeyStepUpOptionsInput = z.infer<typeof passkeyStepUpOptionsSchema>;

/**
 * DELETE /v1/auth/passkeys/:id — fresh proof required when the user has MFA enabled. The body is
 * optional (a DELETE without body is a request without proof).
 */
export const passkeyRevokeSchema = z.preprocess((v) => v ?? {}, mfaProofSchema);
export type PasskeyRevokeInput = z.infer<typeof passkeyRevokeSchema>;

/** POST /v1/auth/mfa/recovery-codes/regenerate — always requires a fresh proof. */
export const recoveryCodesRegenerateSchema = mfaProofSchema;
export type RecoveryCodesRegenerateInput = z.infer<typeof recoveryCodesRegenerateSchema>;
