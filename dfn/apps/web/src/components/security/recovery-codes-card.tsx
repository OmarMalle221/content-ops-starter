'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LifeBuoy, RefreshCw } from 'lucide-react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { CopyButton } from '@/components/copy-button';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { StepUpFields } from './step-up-fields';
import { isMfaCodeInput, type StepUpProof } from './webauthn-client';

export interface RecoveryCodesSummary {
  remaining: number;
  total: number;
  generatedAt: string | null;
  mfaEnabled: boolean;
  nextActions: string[];
}

/** One-time display of freshly generated recovery codes, with copy and an explicit dismissal. */
export function RecoveryCodesDisplay({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
      <p className="text-sm font-medium">{t('passkeys.recovery.showOnceTitle')}</p>
      <p className="text-xs text-muted-foreground">{t('passkeys.recovery.showOnce')}</p>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="rounded-md border bg-background px-2 py-1 text-center tracking-wider">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={codes.join('\n')} label={t('passkeys.recovery.copyAll')} />
        <Button type="button" size="sm" onClick={onDone}>
          {t('passkeys.recovery.done')}
        </Button>
      </div>
    </div>
  );
}

/** Settings card: how many recovery codes remain, and regeneration behind a fresh MFA proof. */
export function RecoveryCodesCard({ summary }: { summary: RecoveryCodesSummary }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const assertion = useRef<AuthenticationResponseJSON | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4" /> {t('passkeys.recovery.title')}
        </CardTitle>
        <CardDescription>{t('passkeys.recovery.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!summary.mfaEnabled ? (
          <p className="text-sm text-muted-foreground">{t('passkeys.recovery.mfaRequired')}</p>
        ) : (
          <>
            <p className="text-sm">
              {t('passkeys.recovery.remaining')
                .replace('{count}', String(summary.remaining))
                .replace('{total}', String(summary.total))}
              {summary.generatedAt ? (
                <span className="text-muted-foreground">
                  {' '}
                  · {t('passkeys.recovery.generatedAt')} {formatDate(summary.generatedAt, locale)}
                </span>
              ) : null}
            </p>
            {summary.remaining <= 3 ? (
              <Alert variant="warning">
                <AlertDescription>{t('passkeys.recovery.low')}</AlertDescription>
              </Alert>
            ) : null}
            {codes ? <RecoveryCodesDisplay codes={codes} onDone={() => setCodes(null)} /> : null}
            {summary.nextActions.includes('REGENERATE') ? (
              <ActionDialog
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    <RefreshCw /> {t('passkeys.recovery.regenerate')}
                  </Button>
                }
                title={t('passkeys.recovery.regenerateTitle')}
                description={t('passkeys.recovery.regenerateHint')}
                confirmLabel={t('passkeys.recovery.regenerate')}
                disabled={!isMfaCodeInput(code)}
                onConfirm={async () => {
                  const proof: StepUpProof = assertion.current
                    ? { passkeyAssertion: assertion.current }
                    : { mfaCode: code };
                  assertion.current = null;
                  let res: { recoveryCodes: string[] };
                  try {
                    res = await api('/v1/auth/mfa/recovery-codes/regenerate', {
                      method: 'POST',
                      json: proof,
                    });
                  } catch (e) {
                    throw new Error(errorMessage(e));
                  }
                  setCode('');
                  setCodes(res.recoveryCodes);
                  router.refresh();
                }}
              >
                <StepUpFields
                  id="recovery-regenerate-code"
                  code={code}
                  onCodeChange={setCode}
                  onPasskey={(a, form) => {
                    assertion.current = a;
                    form?.requestSubmit();
                  }}
                />
              </ActionDialog>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
