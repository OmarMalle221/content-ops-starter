'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Select } from '@dfn/ui';
import { REVIEW_QUEUE_SORTS } from '@dfn/shared';
import { useI18n } from '@/lib/i18n-client';
import {
  REVIEW_QUEUE_PATH,
  REVIEW_QUEUE_SEVERITIES,
  reviewQueueSearch,
  type ReviewQueueFilterState,
  type ReviewQueueView,
} from './review-queue-query';

/** URL-driven filters: every change pushes a new URL and the server page re-fetches the queue. */
export function ReviewQueueFilters({
  filters,
  ruleCodes,
  assignees,
}: {
  filters: ReviewQueueFilterState;
  ruleCodes: string[];
  assignees: Array<{ id: string; name: string }>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const go = (patch: Partial<ReviewQueueFilterState>) =>
    router.push(`${REVIEW_QUEUE_PATH}${reviewQueueSearch({ ...filters, ...patch })}`);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
      <div className="space-y-1">
        <Label htmlFor="rq-view">{t('reviewQueue.filters.view')}</Label>
        <Select
          id="rq-view"
          value={filters.view}
          onChange={(e) => go({ view: e.target.value as ReviewQueueView })}
        >
          <option value="open">{t('reviewQueue.filters.viewOpen')}</option>
          <option value="closed">{t('reviewQueue.filters.viewClosed')}</option>
          <option value="all">{t('reviewQueue.filters.viewAll')}</option>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rq-severity">{t('reviewQueue.filters.severity')}</Label>
        <Select
          id="rq-severity"
          value={filters.severity ?? ''}
          onChange={(e) => go({ severity: e.target.value || undefined })}
        >
          <option value="">{t('reviewQueue.filters.allSeverities')}</option>
          {REVIEW_QUEUE_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(`reviewQueue.severity.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rq-rule">{t('reviewQueue.filters.rule')}</Label>
        <Select
          id="rq-rule"
          value={filters.ruleCode ?? ''}
          onChange={(e) => go({ ruleCode: e.target.value || undefined })}
        >
          <option value="">{t('reviewQueue.filters.allRules')}</option>
          {ruleCodes.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rq-assignee">{t('reviewQueue.filters.assignee')}</Label>
        <Select
          id="rq-assignee"
          value={filters.assignee ?? ''}
          onChange={(e) => go({ assignee: e.target.value || undefined })}
        >
          <option value="">{t('reviewQueue.filters.anyAssignee')}</option>
          <option value="me">{t('reviewQueue.filters.me')}</option>
          <option value="unassigned">{t('reviewQueue.filters.unassigned')}</option>
          {assignees.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rq-from">{t('reviewQueue.filters.from')}</Label>
        <Input
          id="rq-from"
          type="date"
          value={filters.from ?? ''}
          onChange={(e) => go({ from: e.target.value || undefined })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rq-to">{t('reviewQueue.filters.to')}</Label>
        <Input
          id="rq-to"
          type="date"
          value={filters.to ?? ''}
          onChange={(e) => go({ to: e.target.value || undefined })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rq-sort">{t('reviewQueue.filters.sort')}</Label>
        <Select
          id="rq-sort"
          value={filters.sort ?? ''}
          onChange={(e) => go({ sort: e.target.value || undefined })}
        >
          <option value="">—</option>
          {REVIEW_QUEUE_SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`reviewQueue.sorts.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col justify-end gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={Boolean(filters.overdue)}
            onChange={(e) => go({ overdue: e.target.checked || undefined })}
          />
          {t('reviewQueue.filters.overdueOnly')}
        </label>
        <Button asChild size="sm" variant="ghost">
          <Link href={REVIEW_QUEUE_PATH}>{t('reviewQueue.filters.reset')}</Link>
        </Button>
      </div>
    </div>
  );
}
