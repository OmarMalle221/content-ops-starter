'use client';
import { useEffect, useState } from 'react';
import {
  WebAuthnError,
  browserSupportsWebAuthn,
  startAuthentication,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/browser';
import { isTotpCode, normalizeRecoveryCode } from '@dfn/shared';
import { ClientApiError, api, localizedApiError } from '@/lib/api-client';

/** Second factors of the signed-in account (GET /v1/auth/mfa/status, readable before the MFA step). */
export interface MfaFactors {
  mfaEnabled: boolean;
  passkeyCount: number;
  recoveryCodesRemaining: number;
  methods: string[];
}

/** Proof sent to a step-up protected endpoint: a code (TOTP / recovery) OR a passkey assertion. */
export interface StepUpProof {
  mfaCode?: string;
  passkeyAssertion?: AuthenticationResponseJSON;
}

/**
 * WebAuthn feature detection. `null` until mounted: the server render and the first client render
 * are identical (no `window` on the server), then the real answer replaces it.
 */
export function useWebAuthnSupport(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);
  return supported;
}

/** Fetches the account's second factors once mounted (null while loading or on error). */
export function useMfaFactors(enabled = true): MfaFactors | null {
  const [factors, setFactors] = useState<MfaFactors | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api<MfaFactors>('/v1/auth/mfa/status')
      .then((f) => {
        if (alive) setFactors(f);
      })
      .catch(() => {
        if (alive) setFactors(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return factors;
}

/** STEP_UP ceremony: the API issues a challenge bound to this session, the authenticator signs it. */
export async function passkeyStepUpAssertion(): Promise<AuthenticationResponseJSON> {
  const optionsJSON = await api('/v1/auth/passkeys/step-up/options', { method: 'POST' });
  return startAuthentication({ optionsJSON });
}

/** User dismissed the browser prompt, or it timed out. */
export function isCeremonyCancelled(e: unknown): boolean {
  if (e instanceof WebAuthnError) return e.code === 'ERROR_CEREMONY_ABORTED' || e.name === 'NotAllowedError';
  return e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}

export function webAuthnErrorMessage(e: unknown, t: (key: string) => string): string {
  if (e instanceof ClientApiError) return localizedApiError(e, t);
  if (isCeremonyCancelled(e)) return t('passkeys.cancelled');
  return t('passkeys.failed');
}

/** A 6-digit TOTP code or a recovery code (any case, dashes optional). */
export function isMfaCodeInput(value: string): boolean {
  return isTotpCode(value) || normalizeRecoveryCode(value) !== null;
}

/** Keeps what a code may contain while typing: digits, base32 letters and dashes. */
export function sanitizeMfaCodeInput(value: string): string {
  return value
    .replace(/[^0-9A-Za-z-]/g, '')
    .toUpperCase()
    .slice(0, 12);
}
