'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, KeyRound } from 'lucide-react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { StepUpOperation } from '@dfn/shared';
import { Button } from '@dfn/ui';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { StepUpFields } from '@/components/security/step-up-fields';
import type { StepUpProof } from '@/components/security/webauthn-client';
import { ClientApiError, api, localizedApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';

type T = (path: string) => string;

/** KEY_LIFECYCLE_CONFLICT carries a reason; other codes use the shared second-factor wording. */
function lifecycleError(e: unknown, t: T): string {
  if (e instanceof ClientApiError && e.body.code === 'KEY_LIFECYCLE_CONFLICT') {
    const reason = (e.body.details as { reason?: unknown } | undefined)?.reason;
    const key = `keysAdmin.lifecycle.errors.${String(reason)}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return localizedApiError(e, t, 'keysAdmin.lifecycle.errors');
}

/**
 * "Generate a new key" (per purpose) or "Retire" (per decrypt-only managed key). Only rendered when
 * the API offers the action (server-driven `nextActions`). Posts to
 * /v1/admin/keys/:purpose/generate or /v1/admin/keys/:purpose/:keyId/retire with a fresh
 * second-factor proof — a code, or a passkey assertion when this browser and account support it —
 * which the API requires when the admin has two-factor authentication or a passkey.
 */
export function KeysLifecycleAction({
  action,
  purpose,
  keyId,
}: {
  action: 'GENERATE' | 'RETIRE';
  purpose: string;
  keyId?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [mfaCode, setMfaCode] = useState('');
  const assertion = useRef<AuthenticationResponseJSON | null>(null);
  const generate = action === 'GENERATE';
  const label = generate ? t('keysAdmin.lifecycle.generate') : t('keysAdmin.lifecycle.retire');
  const path = generate
    ? `/v1/admin/keys/${encodeURIComponent(purpose)}/generate`
    : `/v1/admin/keys/${encodeURIComponent(purpose)}/${encodeURIComponent(keyId ?? '')}/retire`;

  const submit = async () => {
    const proof: StepUpProof = assertion.current
      ? { passkeyAssertion: assertion.current }
      : mfaCode.trim()
        ? { mfaCode: mfaCode.trim() }
        : {};
    assertion.current = null;
    try {
      await api(path, { method: 'POST', json: proof });
    } catch (e) {
      throw new Error(lifecycleError(e, t));
    }
    setMfaCode('');
    // The refreshed page shows the new key (STAGED) or the RETIRED status in the managed keys table.
    router.refresh();
  };

  return (
    <ActionDialog
      trigger={
        <Button size="sm" variant={generate ? 'outline' : 'destructive'}>
          {generate ? <KeyRound /> : <Archive />} {label}
        </Button>
      }
      title={`${label} — ${generate ? t(`keysAdmin.purposes.${purpose}`) : keyId}`}
      description={
        generate ? t('keysAdmin.lifecycle.generateConfirm') : t('keysAdmin.lifecycle.retireConfirm')
      }
      confirmLabel={label}
      variant={generate ? 'default' : 'destructive'}
      onConfirm={submit}
    >
      <StepUpFields
        id={`keys-${action.toLowerCase()}-${purpose}-${keyId ?? 'new'}`}
        operation={StepUpOperation.KEY_MANAGE}
        resourceId={generate ? purpose : keyId}
        code={mfaCode}
        onCodeChange={setMfaCode}
        hint={t('keysAdmin.lifecycle.mfaHint')}
        onPasskey={(a, form) => {
          // The dialog's own submit path runs the request (loading, error, close on success).
          assertion.current = a;
          form?.requestSubmit();
        }}
      />
    </ActionDialog>
  );
}
