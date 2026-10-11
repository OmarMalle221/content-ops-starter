'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

export function MfaForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/v1/auth/mfa/verify', { method: 'POST', json: { code } });
      router.push(params.get('next') || '/dashboard');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.mfaTitle')}</CardTitle>
        <CardDescription>{t('auth.mfaHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">{t('auth.mfaCode')}</Label>
            <Input
              id="code"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <FormMessage error={error} />
          <Button type="submit" className="w-full" loading={loading}>
            {t('common.confirm')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
