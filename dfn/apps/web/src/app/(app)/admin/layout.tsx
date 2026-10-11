import { redirect } from 'next/navigation';
import { AdminTabs } from '@/components/admin/admin-tabs';
import { getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';
import { PageHeader } from '@/components/shell/page-header';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const [{ t }, session] = await Promise.all([getT(), getSession()]);
  if (!session || session.user.globalRole === 'USER') redirect('/dashboard');
  return (
    <>
      <PageHeader title={t('admin.title')} subtitle={`${session.user.globalRole} · ${t('app.sandbox')}`} />
      <AdminTabs role={session.user.globalRole} />
      <div className="mt-6">{children}</div>
    </>
  );
}
