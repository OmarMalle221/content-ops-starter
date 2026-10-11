'use client';
import { useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { Badge, Button } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { StepUpFields } from '@/components/security/step-up-fields';
import { isMfaCodeInput, type StepUpProof } from '@/components/security/webauthn-client';
import type { TransferDto } from './types';

/**
 * Authorisation dialog: debits the fictitious wallet. When the user has MFA it asks for a fresh
 * proof — TOTP code, recovery code, or (if this browser supports WebAuthn and the account has a
 * passkey) a passkey assertion for a STEP_UP challenge of this session.
 */
export function AuthorizeTransferDialog({
  transfer,
  mfaEnabled,
  onDone,
  variant = 'default',
}: {
  transfer: Pick<TransferDto, 'id' | 'totalDebit' | 'destination' | 'beneficiary'>;
  mfaEnabled: boolean;
  onDone: (updated: TransferDto) => void | Promise<void>;
  variant?: 'default' | 'accent';
}) {
  const { t, locale } = useI18n();
  const [code, setCode] = useState('');
  const assertion = useRef<AuthenticationResponseJSON | null>(null);
  return (
    <ActionDialog
      trigger={
        <Button variant={variant}>
          <ShieldCheck /> {t('xfer.authorize')}
        </Button>
      }
      title={t('xfer.authorizeTitle')}
      description={t('xfer.authorizeDescription')}
      confirmLabel={t('xfer.authorize')}
      variant={variant}
      disabled={mfaEnabled && !isMfaCodeInput(code)}
      onConfirm={async () => {
        const proof: StepUpProof = assertion.current
          ? { passkeyAssertion: assertion.current }
          : mfaEnabled
            ? { mfaCode: code }
            : {};
        assertion.current = null;
        let updated: TransferDto;
        try {
          updated = await api<TransferDto>(`/v1/transfers/${transfer.id}/authorize`, {
            method: 'POST',
            json: proof,
          });
        } catch (e) {
          throw new Error(errorMessage(e));
        }
        setCode('');
        await onDone(updated);
      }}
    >
      <div className="flex items-center gap-2">
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
        <dt className="text-muted-foreground">{t('xfer.totalDebit')}</dt>
        <dd className="text-right font-medium tabular-nums">{formatMoney(transfer.totalDebit, locale)}</dd>
        <dt className="text-muted-foreground">{t('xfer.received')}</dt>
        <dd className="text-right font-medium tabular-nums text-primary">
          {formatMoney(transfer.destination, locale)}
        </dd>
        <dt className="text-muted-foreground">{t('xfer.beneficiary')}</dt>
        <dd className="text-right">
          {transfer.beneficiary.name} · {transfer.beneficiary.accountIdentifierMasked}
        </dd>
      </dl>
      {mfaEnabled ? (
        <StepUpFields
          id="transfer-mfa-code"
          code={code}
          onCodeChange={setCode}
          hint={t('passkeys.transfer.codeHint')}
          passkeyLabel={t('passkeys.transfer.usePasskey')}
          onPasskey={(a, form) => {
            // The dialog's own submit path runs the request (loading, error, close on success).
            assertion.current = a;
            form?.requestSubmit();
          }}
        />
      ) : null}
    </ActionDialog>
  );
}
