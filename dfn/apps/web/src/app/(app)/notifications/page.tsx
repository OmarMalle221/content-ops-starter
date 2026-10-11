import { PageHeader } from '@/components/shell/page-header';
import { NotificationsList } from '@/components/notifications/notifications-list';
import { apiFetch } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  const [{ t }, data] = await Promise.all([getT(), apiFetch<any>('/v1/notifications?pageSize=50')]);
  return (
    <>
      <PageHeader title={t('notif.title')} subtitle={`${data.unread} ${t('status.PENDING').toLowerCase()}`} />
      <NotificationsList items={data.items} />
    </>
  );
}
