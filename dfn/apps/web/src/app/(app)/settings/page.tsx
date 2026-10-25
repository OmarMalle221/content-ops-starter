import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { IdentityVerificationForm } from '@/components/forms/identity-verification-form';
import { MfaCard, PasswordForm, ProfileForm, SessionsCard } from '@/components/forms/settings-forms';
import { SecurityPreferencesCard } from '@/components/forms/security-preferences-card';
import { DeleteAccountCard } from '@/components/forms/delete-account-card';
import { PasskeysCard, type PasskeyItem } from '@/components/security/passkeys-card';
import { RecoveryCodesCard, type RecoveryCodesSummary } from '@/components/security/recovery-codes-card';
import { apiFetch, getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Paramètres' };

export default async function SettingsPage() {
  const [{ t }, session, sessions, passkeys, recovery] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any[]>('/v1/auth/sessions'),
    apiFetch<{ items: PasskeyItem[] }>('/v1/auth/passkeys'),
    apiFetch<RecoveryCodesSummary>('/v1/auth/mfa/recovery-codes'),
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
        <RecoveryCodesCard summary={recovery} />
        <PasskeysCard passkeys={passkeys.items} mfaEnabled={user.mfaEnabled} />
        <SecurityPreferencesCard preferences={(user as any).securityPreferences ?? null} />
        <div className="lg:col-span-2">
          <SessionsCard sessions={sessions} />
        </div>
        <div className="lg:col-span-2">
          <DeleteAccountCard deletionRequestedAt={(user as any).deletionRequestedAt ?? null} />
        </div>
      </div>
    </>
  );
}
