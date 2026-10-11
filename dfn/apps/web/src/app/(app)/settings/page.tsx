import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { IdentityVerificationForm } from '@/components/forms/identity-verification-form';
import { MfaCard, PasswordForm, ProfileForm, SessionsCard } from '@/components/forms/settings-forms';
import { apiFetch, getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Paramètres' };

export default async function SettingsPage() {
  const [{ t }, session, sessions] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any[]>('/v1/auth/sessions'),
  ]);
  const user = session!.user;
  const identity = user.identityVerification;
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ProfileForm user={user} />
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.identity')}</CardTitle>
            <CardDescription>
              <StatusBadge status={identity.status} />{' '}
              {identity.simulated ? `· ${t('common.simulated')}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {identity.status === 'SIMULATED_PASS' ? (
              <p className="text-sm text-success">{t('dashboard.verified')}</p>
            ) : (
              <IdentityVerificationForm />
            )}
          </CardContent>
        </Card>
        <PasswordForm />
        <MfaCard enabled={user.mfaEnabled} />
        <div className="lg:col-span-2">
          <SessionsCard sessions={sessions} />
        </div>
      </div>
    </>
  );
}
