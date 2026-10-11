'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { PasskeyLoginButton } from '@/components/security/passkey-login-button';

export function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function goNext(mfaRequired: boolean) {
    const next = params.get('next') || '/dashboard';
    router.push(mfaRequired ? `/mfa?next=${encodeURIComponent(next)}` : next);
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ mfaRequired: boolean }>('/v1/auth/login', {
        method: 'POST',
        json: { email, password },
      });
      goNext(res.mfaRequired);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.login')}</CardTitle>
        <CardDescription>{t('auth.loginSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <FormMessage error={error} />
          <Button type="submit" className="w-full" loading={loading}>
            {t('auth.login')}
          </Button>
          <div className="flex items-center gap-3 text-xs uppercase text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t('passkeys.or')}
            <span className="h-px flex-1 bg-border" />
          </div>
          {/* A user-verifying passkey is a full sign-in: no MFA step follows. */}
          <PasskeyLoginButton onSignedIn={() => goNext(false)} />
          <p className="text-center text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/register">
              {t('auth.register')}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
