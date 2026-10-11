'use client';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Badge, Button, Input, Label } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import type { TransferDto } from './types';

/** Authorisation dialog: debits the fictitious wallet; asks for a TOTP code when the user has MFA. */
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
  const codeValid = /^\d{6}$/.test(code);
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
      disabled={mfaEnabled && !codeValid}
      onConfirm={async () => {
        let updated: TransferDto;
        try {
          updated = await api<TransferDto>(`/v1/transfers/${transfer.id}/authorize`, {
            method: 'POST',
            json: mfaEnabled ? { mfaCode: code } : {},
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
        <div className="space-y-2">
          <Label htmlFor="transfer-mfa-code">{t('xfer.mfaCode')}</Label>
          <Input
            id="transfer-mfa-code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <p className="text-xs text-muted-foreground">{t('xfer.mfaHint')}</p>
        </div>
      ) : null}
    </ActionDialog>
  );
}
