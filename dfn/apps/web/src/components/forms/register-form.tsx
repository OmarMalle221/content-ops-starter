'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { COUNTRIES } from '@dfn/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

export function RegisterForm({ invitationToken }: { invitationToken?: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [form, setForm] = useState({
    email: params.get('email') ?? '',
    password: '',
    firstName: '',
    lastName: '',
    country: 'CA',
    acceptTerms: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value,
    }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/v1/auth/register', { method: 'POST', json: { ...form, locale, invitationToken } });
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
        <CardTitle>{t('auth.register')}</CardTitle>
        <CardDescription>{t('auth.registerSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="firstName">{t('auth.firstName')}</Label>
              <Input id="firstName" required value={form.firstName} onChange={set('firstName')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">{t('auth.lastName')}</Label>
              <Input id="lastName" required value={form.lastName} onChange={set('lastName')} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={set('email')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">{t('auth.country')}</Label>
            <Select id="country" value={form.country} onChange={set('country')}>
              {Object.values(COUNTRIES).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name[locale]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={form.password}
              onChange={set('password')}
            />
            <p className="text-xs text-muted-foreground">{t('auth.passwordHint')}</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.acceptTerms}
              onChange={set('acceptTerms')}
              required
            />
            <span>{t('auth.acceptTerms')}</span>
          </label>
          <FormMessage error={error} />
          <Button type="submit" className="w-full" loading={loading} disabled={!form.acceptTerms}>
            {t('auth.register')}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {t('auth.hasAccount')}{' '}
            <Link className="font-medium text-primary underline-offset-4 hover:underline" href="/login">
              {t('auth.login')}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
