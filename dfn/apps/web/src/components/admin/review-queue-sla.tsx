'use client';
import { Badge } from '@dfn/ui';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';

/**
 * Deterministic duration ("2 j 3 h", "5 h 10 min", "45 min") from whole minutes. The minutes are
 * computed by the API (slaRemainingMinutes / ageMinutes) so rendering never reads the clock.
 */
export function formatMinutes(total: number, units: { d: string; h: string; min: string }): string {
  const m = Math.abs(Math.trunc(total));
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const minutes = m % 60;
  if (days > 0) return hours ? `${days} ${units.d} ${hours} ${units.h}` : `${days} ${units.d}`;
  if (hours > 0) return minutes ? `${hours} ${units.h} ${minutes} ${units.min}` : `${hours} ${units.h}`;
  return `${minutes} ${units.min}`;
}

export function useDurationFormatter() {
  const { t } = useI18n();
  const units = { d: t('reviewQueue.units.d'), h: t('reviewQueue.units.h'), min: t('reviewQueue.units.min') };
  return (minutes: number) => formatMinutes(minutes, units);
}

/** SLA badge: "due in …" (amber under 4 h), "overdue by …" (red), or "decided" for closed alerts. */
export function ReviewQueueSlaBadge({
  dueAt,
  slaRemainingMinutes,
  slaBreachedAt,
}: {
  dueAt: string | null;
  slaRemainingMinutes: number | null;
  slaBreachedAt: string | null;
}) {
  const { t, locale } = useI18n();
  const duration = useDurationFormatter();
  if (slaRemainingMinutes === null) {
    return <Badge variant="muted">{t('reviewQueue.sla.decided')}</Badge>;
  }
  const overdue = slaRemainingMinutes < 0;
  const label = overdue
    ? t('reviewQueue.sla.overdueBy').replace('{d}', duration(slaRemainingMinutes))
    : t('reviewQueue.sla.dueIn').replace('{d}', duration(slaRemainingMinutes));
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge
        variant={overdue ? 'destructive' : slaRemainingMinutes < 240 ? 'warning' : 'outline'}
        title={`${t('reviewQueue.sla.dueAt')} : ${formatDate(dueAt, locale, true)}`}
      >
        {label}
      </Badge>
      {slaBreachedAt ? (
        <Badge variant="destructive" title={formatDate(slaBreachedAt, locale, true)}>
          {t('reviewQueue.sla.breached')}
        </Badge>
      ) : null}
    </span>
  );
}
