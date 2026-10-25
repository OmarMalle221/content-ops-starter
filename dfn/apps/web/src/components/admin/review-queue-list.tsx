'use client';
import Link from 'next/link';
import { Badge, Card, CardContent, EmptyState } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { RiskAlertActions } from '@/components/admin/admin-actions';
import { formatDate, formatMoney, statusVariant } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { ReviewQueueAssign } from './review-queue-assign';
import { ReviewQueueSlaBadge, useDurationFormatter } from './review-queue-sla';
import { riskRuleText } from './risk-rule-text';

type Scalar = string | number | boolean | null;

/** Alert as returned by GET /v1/admin/risk-alerts (review queue DTO). */
export interface ReviewQueueItem {
  id: string;
  ruleCode: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  status: string;
  explanation: {
    summary?: string;
    recommendation?: string;
    factors?: Record<string, Scalar>;
    evidence?: Array<Record<string, Scalar>>;
    updates?: unknown[];
  } | null;
  createdAt: string;
  dueAt: string | null;
  overdue: boolean;
  slaRemainingMinutes: number | null;
  slaBreachedAt: string | null;
  firstActionAt: string | null;
  ageMinutes: number;
  ageHours: number;
  assignedTo: { id: string; name: string; email?: string } | null;
  assignedAt: string | null;
  user: { id: string; email: string; firstName: string; lastName: string } | null;
  organization: { id: string; name: string } | null;
  transaction: { id: string; reference: string; title: string } | null;
  resolvedBy: { id: string; name: string } | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  actions: Array<{
    id: string;
    action: string;
    note: string | null;
    createdAt: string;
    actor: { id: string; firstName: string; lastName: string };
  }>;
  nextActions: string[];
}

function Evidence({ items, currency }: { items: Array<Record<string, Scalar>>; currency: string | null }) {
  const { t, locale } = useI18n();
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {t('reviewQueue.item.operations')} ({items.length})
      </summary>
      <ul className="mt-1 space-y-0.5">
        {items.map((op, i) => (
          <li key={`${String(op.reference)}-${i}`} className="font-mono">
            {String(op.kind ?? '')} · {String(op.reference ?? '')} ·{' '}
            {currency && op.amountMinor != null
              ? formatMoney(
                  { minor: String(op.amountMinor), decimal: String(op.amount ?? '0'), currency },
                  locale,
                )
              : String(op.amount ?? '')}{' '}
            · {formatDate(String(op.occurredAt ?? ''), locale, true)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AlertCard({ a, assignees }: { a: ReviewQueueItem; assignees: Array<{ id: string; name: string }> }) {
  const { t, locale } = useI18n();
  const duration = useDurationFormatter();
  const factors = a.explanation?.factors ?? {};
  const currency = typeof factors.currencyCode === 'string' ? factors.currencyCode : null;
  const updates = Array.isArray(a.explanation?.updates) ? a.explanation!.updates!.length : 0;
  return (
    <Card className={a.overdue ? 'border-destructive/40' : undefined}>
      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(a.severity)}>{t(`reviewQueue.severity.${a.severity}`)}</Badge>
            <span className="font-mono text-sm font-medium">{a.ruleCode}</span>
            <StatusBadge status={a.status} />
            <ReviewQueueSlaBadge
              dueAt={a.dueAt}
              slaRemainingMinutes={a.slaRemainingMinutes}
              slaBreachedAt={a.slaBreachedAt}
            />
            <span className="text-xs text-muted-foreground">
              {t('reviewQueue.item.score')} {a.score}
            </span>
          </div>
          {a.explanation?.summary ? (
            <p className="text-sm">{riskRuleText(t, a.ruleCode, a.explanation.summary)}</p>
          ) : null}
          {a.explanation?.recommendation ? (
            <p className="text-xs text-muted-foreground">
              {riskRuleText(t, a.ruleCode, a.explanation.recommendation)}
            </p>
          ) : null}
          {a.explanation?.evidence?.length ? (
            <Evidence items={a.explanation.evidence} currency={currency} />
          ) : null}
          {updates ? (
            <p className="text-xs text-muted-foreground">
              {t('reviewQueue.item.repeated').replace('{n}', String(updates))}
            </p>
          ) : null}
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div>
              <dt className="inline text-muted-foreground">{t('reviewQueue.item.created')} : </dt>
              <dd className="inline">
                {formatDate(a.createdAt, locale, true)} ({t('reviewQueue.item.age')} {duration(a.ageMinutes)})
              </dd>
            </div>
            {a.user ? (
              <div>
                <dt className="inline text-muted-foreground">{t('reviewQueue.item.subject')} : </dt>
                <dd className="inline">{a.user.email}</dd>
              </div>
            ) : null}
            {a.organization ? (
              <div>
                <dt className="inline text-muted-foreground">{t('reviewQueue.item.organization')} : </dt>
                <dd className="inline">{a.organization.name}</dd>
              </div>
            ) : null}
            {a.transaction ? (
              <div>
                <dt className="inline text-muted-foreground">{t('reviewQueue.item.transaction')} : </dt>
                <dd className="inline">
                  <Link href={`/transactions/${a.transaction.id}`} className="text-primary hover:underline">
                    {a.transaction.reference}
                  </Link>
                </dd>
              </div>
            ) : null}
            {a.firstActionAt ? (
              <div>
                <dt className="inline text-muted-foreground">{t('reviewQueue.item.firstAction')} : </dt>
                <dd className="inline">{formatDate(a.firstActionAt, locale, true)}</dd>
              </div>
            ) : null}
            {a.resolvedBy ? (
              <div>
                <dt className="inline text-muted-foreground">{t('reviewQueue.item.resolvedBy')} : </dt>
                <dd className="inline">
                  {a.resolvedBy.name} · {formatDate(a.resolvedAt, locale, true)}
                </dd>
              </div>
            ) : null}
          </dl>
          {a.actions.length ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {t('reviewQueue.item.history')} ({a.actions.length})
              </summary>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {a.actions.map((x) => {
                  const label = t(`reviewQueue.actionNames.${x.action}`);
                  return (
                    <li key={x.id}>
                      {formatDate(x.createdAt, locale, true)} —{' '}
                      {label.startsWith('reviewQueue.') ? x.action : label} —{' '}
                      {x.note || t('reviewQueue.item.noNote')} ({x.actor.firstName} {x.actor.lastName})
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-3 lg:w-72 lg:items-end">
          <ReviewQueueAssign alert={a} assignees={assignees} />
          <RiskAlertActions alert={a} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Review queue items (one card per alert; per-alert actions only, no bulk action). */
export function ReviewQueueList({
  items,
  assignees,
}: {
  items: ReviewQueueItem[];
  assignees: Array<{ id: string; name: string }>;
}) {
  const { t } = useI18n();
  if (!items.length) return <EmptyState title={t('reviewQueue.empty')} description={t('app.sandbox')} />;
  return (
    <div className="space-y-3">
      {items.map((a) => (
        <AlertCard key={a.id} a={a} assignees={assignees} />
      ))}
    </div>
  );
}
