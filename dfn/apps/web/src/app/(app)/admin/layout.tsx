import { redirect } from 'next/navigation';
import { AdminTabs } from '@/components/admin/admin-tabs';
import { getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';
import { PageHeader } from '@/components/shell/page-header';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const [{ t }, session] = await Promise.all([getT(), getSession()]);
  // REQUIRE_STAFF_MFA: staff tools stay off until the account enables MFA, which happens in the
  // settings (the app shell explains why). `globalRole` is the effective role ('USER' meanwhile).
  if (session?.user.staffMfaRequired) redirect('/settings');
  if (!session || session.user.globalRole === 'USER') redirect('/dashboard');
  return (
    <>
      <PageHeader title={t('admin.title')} subtitle={`${session.user.globalRole} · ${t('app.sandbox')}`} />
      <AdminTabs role={session.user.globalRole} />
      <div className="mt-6">{children}</div>
    </>
  );
}
