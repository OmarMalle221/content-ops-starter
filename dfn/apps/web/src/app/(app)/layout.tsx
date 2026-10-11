import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/app-shell';
import { apiFetchOptional, getSession } from '@/lib/api-server';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.mfaRequired) redirect('/mfa');
  const notifications = await apiFetchOptional<{ unread: number }>('/v1/notifications?pageSize=1');
  return (
    <AppShell user={session.user} unread={notifications?.unread ?? 0}>
      {children}
    </AppShell>
  );
}
