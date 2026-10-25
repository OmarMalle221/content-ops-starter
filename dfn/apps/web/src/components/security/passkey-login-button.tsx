'use client';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { useWebAuthnSupport, webAuthnErrorMessage } from './webauthn-client';

/**
 * Passwordless sign-in with a discoverable passkey. The options request never depends on the
 * account (no allowCredentials): the browser lets the user pick one of their passkeys for this
 * site. When WebAuthn is unavailable an explanation replaces the button.
 */
export function PasskeyLoginButton({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const supported = useWebAuthnSupport();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (supported === null) {
    return <p className="text-center text-xs text-muted-foreground">{t('passkeys.checking')}</p>;
  }
  if (!supported) {
    return <p className="text-center text-xs text-muted-foreground">{t('passkeys.unsupported')}</p>;
  }
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        loading={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            // No e-mail is sent: the answer would be the same for every account anyway.
            const optionsJSON = await api('/v1/auth/passkeys/authentication/options', {
              method: 'POST',
              json: {},
            });
            const response = await startAuthentication({ optionsJSON });
            await api('/v1/auth/passkeys/authentication/verify', { method: 'POST', json: { response } });
            onSignedIn();
          } catch (err) {
            setError(webAuthnErrorMessage(err, t));
          } finally {
            setLoading(false);
          }
        }}
      >
        <KeyRound /> {t('passkeys.loginWith')}
      </Button>
      <p className="text-center text-xs text-muted-foreground">{t('passkeys.loginHint')}</p>
      <FormMessage error={error} />
    </div>
  );
}
