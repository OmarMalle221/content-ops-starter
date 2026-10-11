'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';
import { Button, EmptyState, cn } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';

export function NotificationsList({ items }: { items: any[] }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  if (items.length === 0) return <EmptyState icon={<Bell />} title={t('notif.empty')} />;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => api('/v1/notifications/read-all', { method: 'POST' }).then(() => router.refresh())}
        >
          <CheckCheck /> {t('notif.markAll')}
        </Button>
      </div>
      <ul className="divide-y rounded-xl border bg-card">
        {items.map((n) => {
          const href = n.data?.transactionId
            ? `/transactions/${n.data.transactionId}`
            : n.data?.disputeId
              ? `/disputes/${n.data.disputeId}`
              : undefined;
          return (
            <li key={n.id} className={cn('flex items-start gap-3 p-4', !n.readAt && 'bg-primary/5')}>
              <span
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  n.readAt ? 'bg-transparent' : 'bg-accent',
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{n.title}</p>
                <p className="text-sm text-muted-foreground">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatDate(n.createdAt, locale, true)}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {href ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={href}
                      onClick={() => void api(`/v1/notifications/${n.id}/read`, { method: 'POST' })}
                    >
                      {t('common.open')}
                    </Link>
                  </Button>
                ) : null}
                {!n.readAt ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Mark read"
                    onClick={() =>
                      api(`/v1/notifications/${n.id}/read`, { method: 'POST' }).then(() => router.refresh())
                    }
                  >
                    <CheckCheck />
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
