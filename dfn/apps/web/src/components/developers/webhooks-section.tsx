import Link from 'next/link';
import { Eye, EyeOff, Send, Webhook as WebhookIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { formatDate, statusVariant } from '@/lib/format';
import { getT } from '@/lib/i18n-server';
import { DeliveryRetryButton } from './delivery-retry-button';
import { RecordPicker } from './record-picker';
import { WebhookActions } from './webhook-actions';
import { WebhookCreateDialog } from './webhook-create-dialog';
import { devHref, type Paginated, type Webhook, type WebhookDelivery } from './types';

export async function WebhooksSection({
  organizationId,
  webhooks,
  allWebhooks,
  events,
  includeRevoked,
  selected,
  deliveries,
}: {
  organizationId: string;
  /** Webhooks shown in the table (filtered by includeRevoked). */
  webhooks: Webhook[];
  /** Every webhook of the organisation, deleted ones included (delivery history stays readable). */
  allWebhooks: Webhook[];
  events: string[];
  includeRevoked: boolean;
  selected: Webhook | null;
  deliveries: Paginated<WebhookDelivery> | null;
}) {
  const { t, locale } = await getT();
  const toggleHref = devHref(organizationId, 'webhooks', {
    includeRevoked: includeRevoked ? undefined : 'true',
    webhookId: selected?.id,
  });
  const totalPages = deliveries ? Math.max(1, Math.ceil(deliveries.total / deliveries.pageSize)) : 1;
  const pageHref = (page: number) =>
    devHref(organizationId, 'webhooks', {
      includeRevoked: includeRevoked ? 'true' : undefined,
      webhookId: selected?.id,
      page: page > 1 ? page : undefined,
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <WebhookIcon className="size-4" /> {t('webhooks.title')}
            </CardTitle>
            <CardDescription>{t('webhooks.description')}</CardDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={toggleHref}>
                {includeRevoked ? <EyeOff /> : <Eye />}{' '}
                {includeRevoked ? t('webhooks.hideRevoked') : t('webhooks.showRevoked')}
              </Link>
            </Button>
            <WebhookCreateDialog organizationId={organizationId} events={events} size="sm" />
          </div>
        </CardHeader>
        <CardContent>
          {webhooks.length === 0 ? (
            <EmptyState
              icon={<WebhookIcon />}
              title={t('webhooks.empty')}
              description={t('webhooks.emptyHint')}
              action={<WebhookCreateDialog organizationId={organizationId} events={events} />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('webhooks.url')}</TableHead>
                  <TableHead>{t('webhooks.events')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('webhooks.failures')}</TableHead>
                  <TableHead>{t('webhooks.lastDelivery')}</TableHead>
                  <TableHead className="text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {webhooks.map((w) => (
                  <TableRow key={w.id} className={w.status === 'REVOKED' ? 'opacity-60' : ''}>
                    <TableCell>
                      <div className="max-w-[320px] truncate font-mono text-xs" title={w.url}>
                        {w.url}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {w.description ? `${w.description} · ` : ''}
                        {t('common.created')} {formatDate(w.createdAt, locale)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-[260px] flex-wrap gap-1">
                        {w.events.map((e) => (
                          <Badge key={e} variant="outline" className="font-mono text-[11px]">
                            {e}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(w.status)}>{t(`dev.statuses.${w.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <span className={w.failureCount > 0 ? 'text-warning' : ''}>{w.failureCount}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {t('webhooks.autoDisabled')}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {w.lastDeliveryAt ? formatDate(w.lastDeliveryAt, locale, true) : t('webhooks.never')}
                    </TableCell>
                    <TableCell className="text-right">
                      <WebhookActions webhook={w} events={events} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Send className="size-4" /> {t('webhooks.deliveries')}
            </CardTitle>
            <CardDescription>{t('webhooks.deliveriesDescription')}</CardDescription>
          </div>
          {selected ? (
            <RecordPicker
              label={t('webhooks.selectWebhook')}
              options={allWebhooks.map((w) => ({
                id: w.id,
                label: `${w.url}${w.status === 'REVOKED' ? ` (${t('dev.statuses.REVOKED')})` : ''}`,
              }))}
              value={selected.id}
              basePath="/developers"
              query={{
                organizationId,
                tab: 'webhooks',
                ...(includeRevoked ? { includeRevoked: 'true' } : {}),
              }}
              param="webhookId"
            />
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {!selected || !deliveries ? (
            <EmptyState icon={<Send />} title={t('webhooks.noWebhooks')} description={t('app.sandbox')} />
          ) : deliveries.items.length === 0 ? (
            <EmptyState
              icon={<Send />}
              title={t('webhooks.deliveriesEmpty')}
              description={t('webhooks.deliveriesEmptyHint')}
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {deliveries.total} {t('webhooks.results')} · {t('app.sandbox')}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.date')}</TableHead>
                    <TableHead>{t('webhooks.event')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('webhooks.attempts')}</TableHead>
                    <TableHead>{t('webhooks.lastStatus')}</TableHead>
                    <TableHead>{t('webhooks.nextAttempt')}</TableHead>
                    <TableHead>{t('webhooks.lastError')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.items.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(d.createdAt, locale, true)}
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-xs">{d.eventType}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{d.id}</div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={d.status} />
                      </TableCell>
                      <TableCell className="tabular-nums">{d.attempts}</TableCell>
                      <TableCell className="font-mono text-xs">{d.lastStatusCode ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {d.status === 'DELIVERED'
                          ? `${t('webhooks.deliveredAt')} ${formatDate(d.deliveredAt, locale, true)}`
                          : d.nextAttemptAt
                            ? formatDate(d.nextAttemptAt, locale, true)
                            : '—'}
                      </TableCell>
                      <TableCell
                        className="max-w-[220px] truncate text-xs text-destructive"
                        title={d.lastError ?? ''}
                      >
                        {d.lastError ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <DeliveryRetryButton webhookId={selected.id} delivery={d} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {totalPages > 1 ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('dev.logs.page')} {deliveries.page} / {totalPages}
                  </span>
                  <div className="flex gap-2">
                    {deliveries.page > 1 ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={pageHref(deliveries.page - 1)}>{t('dev.logs.previous')}</Link>
                      </Button>
                    ) : null}
                    {deliveries.page < totalPages ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={pageHref(deliveries.page + 1)}>{t('dev.logs.next')}</Link>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
