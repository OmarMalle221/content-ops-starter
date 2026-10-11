'use client';
import { AlarmClock, Inbox, Timer, UserCheck, UserX } from 'lucide-react';
import { Stat } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';
import { useDurationFormatter } from './review-queue-sla';

export interface ReviewQueueStatsData {
  open: number;
  overdue: number;
  unassigned: number;
  assignedToMe: number;
  slaBreached: number;
  medianTimeToFirstAction: { windowDays: number; sampleSize: number; minutes: number | null };
  slaHours: { HIGH: number; MEDIUM: number; LOW: number };
}

/** Header of the review queue: workload, SLA health and responsiveness (figures from the API). */
export function ReviewQueueStats({ stats }: { stats: ReviewQueueStatsData }) {
  const { t } = useI18n();
  const duration = useDurationFormatter();
  const median = stats.medianTimeToFirstAction;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t('reviewQueue.stats.open')} value={stats.open} icon={<Inbox />} />
        <Stat
          label={t('reviewQueue.stats.overdue')}
          value={<span className={stats.overdue ? 'text-destructive' : undefined}>{stats.overdue}</span>}
          hint={`${t('reviewQueue.stats.breached')} : ${stats.slaBreached}`}
          icon={<AlarmClock />}
        />
        <Stat label={t('reviewQueue.stats.unassigned')} value={stats.unassigned} icon={<UserX />} />
        <Stat label={t('reviewQueue.stats.mine')} value={stats.assignedToMe} icon={<UserCheck />} />
        <Stat
          label={t('reviewQueue.stats.medianFirstAction')}
          value={median.minutes === null ? t('reviewQueue.stats.none') : duration(median.minutes)}
          hint={t('reviewQueue.stats.medianHint').replace('{n}', String(median.sampleSize))}
          icon={<Timer />}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('reviewQueue.stats.slaHint')
          .replace('{high}', String(stats.slaHours.HIGH))
          .replace('{medium}', String(stats.slaHours.MEDIUM))
          .replace('{low}', String(stats.slaHours.LOW))}
      </p>
    </div>
  );
}
