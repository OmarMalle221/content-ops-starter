import Link from 'next/link';
import { Bell } from 'lucide-react';
import { MarkAllRead } from '@/components/app/mark-read';
import { EmptyState, PageHeader } from '@/components/app/layout-bits';
import { Card } from '@/components/ui/card';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { heldPlatformRoles } from '@/server/auth/actor';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export const metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
    const actor = await requireActor();
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.notifications.list(actor);
    // Staff links go to the back office, which asks for the MFA challenge first when it is not recent.
    const staff = heldPlatformRoles(actor).length > 0;
    return (
        <>
            <PageHeader title={t('notifications.title')} actions={list.some((n) => !n.readAt) ? <MarkAllRead /> : undefined} />
            {list.length === 0 ? (
                <EmptyState icon={Bell} title={t('notifications.empty')} />
            ) : (
                <Card>
                    <ul className="divide-y">
                        {list.map((n) => {
                            const params = { ...n.params };
                            if (params.role) params.role = t(`partyRole.${params.role}`);
                            if (params.type && n.type.startsWith('document')) params.type = t(`documentType.${params.type}`);
                            const text = t(`notifications.types.${n.type}`, params);
                            const href = n.transactionId
                                ? staff
                                    ? `/admin/transactions/${n.transactionId}`
                                    : `/transactions/${n.transactionId}`
                                : undefined;
                            return (
                                <li key={n.id} className={cn('flex items-start gap-3 px-5 py-3', !n.readAt && 'bg-primary-soft/40')}>
                                    <span
                                        className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')}
                                        aria-hidden
                                    />
                                    <div className="min-w-0 flex-1">
                                        {href ? (
                                            <Link href={href} className="text-sm font-medium hover:underline">
                                                {text}
                                            </Link>
                                        ) : (
                                            <p className="text-sm font-medium">{text}</p>
                                        )}
                                        <p className="text-xs text-muted-foreground">{fmtDate(n.createdAt, intl, true)}</p>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </Card>
            )}
        </>
    );
}
