'use client';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import type { StepUpOperation } from '@dfn/shared';
import { Button, Input, Label } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import {
  passkeyStepUpAssertion,
  sanitizeMfaCodeInput,
  useMfaFactors,
  useWebAuthnSupport,
  webAuthnErrorMessage,
} from './webauthn-client';

/**
 * Fresh second-factor proof for a sensitive operation: a code field (TOTP or recovery code) and,
 * when this browser supports WebAuthn AND the account has a passkey, a "confirm with a passkey"
 * button that runs the STEP_UP ceremony and hands the assertion to `onPasskey` (the parent then
 * calls the protected endpoint with `passkeyAssertion`). The challenge is requested for
 * `operation` (+ `resourceId`): the assertion is only accepted by that action of the API. Nothing
 * is rendered for passkeys otherwise — no dead button.
 */
export function StepUpFields({
  id,
  operation,
  resourceId,
  code,
  onCodeChange,
  onPasskey,
  hint,
  passkeyLabel,
  passkeyDisabled,
}: {
  id: string;
  /** Operation the passkey proof is requested for (must match the endpoint the parent calls). */
  operation: StepUpOperation;
  /** Resource of that operation, exactly as the API identifies it (transfer id, gate code…). */
  resourceId?: string;
  code: string;
  onCodeChange: (value: string) => void;
  /** Receives the assertion and the enclosing form (to submit it), when the user picks a passkey. */
  onPasskey?: (assertion: AuthenticationResponseJSON, form: HTMLFormElement | null) => void | Promise<void>;
  hint?: string;
  passkeyLabel?: string;
  /** Disables the passkey button while the surrounding form is incomplete. */
  passkeyDisabled?: boolean;
}) {
  const { t } = useI18n();
  const supported = useWebAuthnSupport();
  const factors = useMfaFactors(Boolean(onPasskey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passkeyAvailable = Boolean(onPasskey) && supported === true && (factors?.passkeyCount ?? 0) > 0;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={id}>{t('passkeys.stepUp.codeLabel')}</Label>
        <Input
          id={id}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          placeholder="123456"
          value={code}
          onChange={(e) => onCodeChange(sanitizeMfaCodeInput(e.target.value))}
        />
        <p className="text-xs text-muted-foreground">{hint ?? t('passkeys.stepUp.codeHint')}</p>
      </div>
      {passkeyAvailable ? (
        <>
          <div className="flex items-center gap-3 text-xs uppercase text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t('passkeys.or')}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            loading={busy}
            disabled={passkeyDisabled}
            onClick={async (e) => {
              const form = e.currentTarget.form;
              setBusy(true);
              setError(null);
              try {
                const assertion = await passkeyStepUpAssertion(operation, resourceId);
                await onPasskey!(assertion, form);
              } catch (err) {
                setError(webAuthnErrorMessage(err, t));
              } finally {
                setBusy(false);
              }
            }}
          >
            <KeyRound /> {passkeyLabel ?? t('passkeys.stepUp.usePasskey')}
          </Button>
          <FormMessage error={error} />
        </>
      ) : null}
    </div>
  );
}
