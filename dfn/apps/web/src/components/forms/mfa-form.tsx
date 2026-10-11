'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import {
  isMfaCodeInput,
  passkeyStepUpAssertion,
  sanitizeMfaCodeInput,
  useMfaFactors,
  useWebAuthnSupport,
  webAuthnErrorMessage,
} from '@/components/security/webauthn-client';

/**
 * Login MFA step: 6-digit TOTP code, or a single-use recovery code, or — when this browser
 * supports WebAuthn and the account has a passkey — a passkey assertion (STEP_UP challenge).
 */
export function MfaForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const supported = useWebAuthnSupport();
  const factors = useMfaFactors();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const valid = mode === 'totp' ? /^\d{6}$/.test(code) : isMfaCodeInput(code);
  const passkeyAvailable = supported === true && (factors?.passkeyCount ?? 0) > 0;

  function done() {
    router.push(params.get('next') || '/dashboard');
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/v1/auth/mfa/verify', { method: 'POST', json: { code } });
      done();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function withPasskey() {
    setPasskeyLoading(true);
    setError(null);
    try {
      const passkeyAssertion = await passkeyStepUpAssertion();
      await api('/v1/auth/mfa/verify', { method: 'POST', json: { passkeyAssertion } });
      done();
    } catch (err) {
      setError(webAuthnErrorMessage(err, t));
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.mfaTitle')}</CardTitle>
        <CardDescription>
          {mode === 'totp' ? t('auth.mfaHint') : t('passkeys.mfa.recoveryHint')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {mode === 'totp' ? (
            <div className="space-y-2">
              <Label htmlFor="code">{t('auth.mfaCode')}</Label>
              <Input
                id="code"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="recovery-code">{t('passkeys.mfa.recoveryLabel')}</Label>
              <Input
                id="recovery-code"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={12}
                placeholder="XXXX-XXXX-XX"
                autoFocus
                value={code}
                onChange={(e) => setCode(sanitizeMfaCodeInput(e.target.value))}
              />
            </div>
          )}
          <FormMessage error={error} />
          <Button type="submit" className="w-full" loading={loading} disabled={!valid}>
            {t('common.confirm')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setMode((m) => (m === 'totp' ? 'recovery' : 'totp'));
              setCode('');
              setError(null);
            }}
          >
            {mode === 'totp' ? t('passkeys.mfa.recoveryToggle') : t('passkeys.mfa.totpToggle')}
          </Button>
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
                loading={passkeyLoading}
                onClick={withPasskey}
              >
                <KeyRound /> {t('passkeys.mfa.usePasskey')}
              </Button>
            </>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
