import Link from 'next/link';
import { Download } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { ReviewQueueFilters } from '@/components/admin/review-queue-filters';
import { ReviewQueueList, type ReviewQueueItem } from '@/components/admin/review-queue-list';
import {
  REVIEW_QUEUE_PAGE_SIZE,
  REVIEW_QUEUE_PATH,
  parseReviewQueueParams,
  reviewQueueApiQuery,
  reviewQueueSearch,
} from '@/components/admin/review-queue-query';
import { ReviewQueueStats, type ReviewQueueStatsData } from '@/components/admin/review-queue-stats';
import { riskRuleText } from '@/components/admin/risk-rule-text';
import { apiFetch } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'File de revue conformité — administration' };

interface QueueResponse {
  items: ReviewQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  rules: Array<{ code: string; description: string; appliesTo: string[] }>;
}

/**
 * Compliance review queue (staff): URL-driven filters, SLA badges, assignment, per-alert decisions
 * through the existing action endpoints, CSV export of the filtered queue and queue statistics.
 */
export default async function AdminRiskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { filters, page } = parseReviewQueueParams(await searchParams);
  const [{ t }, queue, stats, assignees] = await Promise.all([
    getT(),
    apiFetch<QueueResponse>(
      `/v1/admin/risk-alerts${reviewQueueApiQuery(filters, page, REVIEW_QUEUE_PAGE_SIZE)}`,
    ),
    apiFetch<ReviewQueueStatsData>('/v1/admin/risk-alerts/stats'),
    apiFetch<{ items: Array<{ id: string; name: string }> }>('/v1/admin/risk-alerts/assignees'),
  ]);
  const pages = Math.max(1, Math.ceil(queue.total / queue.pageSize));
  const csvHref = `/api/v1/admin/risk-alerts.csv${reviewQueueApiQuery(filters)}`;
  const staff = assignees.items.map((u) => ({ id: u.id, name: u.name }));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>
                {t('reviewQueue.title')}{' '}
                <Badge variant={stats.open ? 'warning' : 'muted'}>{stats.open}</Badge>
              </CardTitle>
              <CardDescription>{t('reviewQueue.description')}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="sandbox">{t('app.sandbox')}</Badge>
              <Button asChild variant="outline" size="sm" title={t('reviewQueue.exportHint')}>
                <a href={csvHref}>
                  <Download /> {t('reviewQueue.export')}
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <ReviewQueueStats stats={stats} />
          <ReviewQueueFilters
            filters={filters}
            ruleCodes={queue.rules.map((r) => r.code).sort()}
            assignees={staff}
          />
        </CardContent>
      </Card>

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {queue.total} {t('reviewQueue.results')} · {t(`reviewQueue.sorts.${queue.sort}`)}
        </p>
        <ReviewQueueList items={queue.items} assignees={staff} />
        {pages > 1 ? (
          <nav className="flex items-center justify-between gap-2 text-sm" aria-label="Pagination">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`${REVIEW_QUEUE_PATH}${reviewQueueSearch(filters, page - 1)}`}>
                  {t('reviewQueue.pagination.previous')}
                </Link>
              </Button>
            ) : (
              <span />
            )}
            <span className="text-muted-foreground">
              {t('reviewQueue.pagination.page')
                .replace('{page}', String(page))
                .replace('{pages}', String(pages))}
            </span>
            {page < pages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`${REVIEW_QUEUE_PATH}${reviewQueueSearch(filters, page + 1)}`}>
                  {t('reviewQueue.pagination.next')}
                </Link>
              </Button>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('reviewQueue.rules')}</CardTitle>
          <CardDescription>{t('reviewQueue.rulesHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-xs sm:grid-cols-2">
            {queue.rules.map((r) => (
              <li key={r.code} className="rounded-md border p-2">
                <Link
                  href={`${REVIEW_QUEUE_PATH}${reviewQueueSearch({ view: 'all', ruleCode: r.code })}`}
                  className="font-mono font-medium text-primary hover:underline"
                >
                  {r.code}
                </Link>
                <p className="text-muted-foreground">{riskRuleText(t, r.code, r.description)}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
