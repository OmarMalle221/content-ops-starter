import Link from 'next/link';
import {
  Badge,
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
import { TransferFilters } from '@/components/transfers/transfer-filters';
import { TransferReviewButtons } from '@/components/transfers/transfer-review-buttons';
import { TRANSFER_STATUSES, type AdminTransferRow } from '@/components/transfers/types';
import { apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Transferts — administration' };

const STATUSES = new Set<string>(TRANSFER_STATUSES);

interface AdminList {
  items: AdminTransferRow[];
  total: number;
  page: number;
  pageSize: number;
  reviewQueue: number;
}

export default async function AdminTransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const status = sp.status && STATUSES.has(sp.status) ? sp.status : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (status) qs.set('status', status);
  const [queue, all] = await Promise.all([
    apiFetch<AdminList>('/v1/admin/transfers?status=REVIEW_REQUIRED&pageSize=50'),
    apiFetch<AdminList>(`/v1/admin/transfers?${qs.toString()}`),
  ]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              {t('xferAdmin.queue')} <Badge variant={queue.total ? 'warning' : 'muted'}>{queue.total}</Badge>
            </CardTitle>
            <Badge variant="sandbox">{t('app.sandbox')}</Badge>
          </div>
          <CardDescription>{t('xferAdmin.queueDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {queue.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('xferAdmin.queueEmpty')}</p>
          ) : null}
          {queue.items.map((x) => (
            <div
              key={x.id}
              className="flex flex-col gap-3 rounded-lg border p-4 lg:flex-row lg:items-start lg:justify-between"
            >
              <div className="min-w-0 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/transfers/${x.id}`} className="font-medium text-primary hover:underline">
                    {x.reference}
                  </Link>
                  <StatusBadge status={x.status} />
                  {typeof x.riskScore === 'number' ? (
                    <Badge variant={x.riskScore >= 40 ? 'destructive' : 'warning'}>
                      {t('xferAdmin.score')} {x.riskScore}
                    </Badge>
                  ) : null}
                </div>
                <p>
                  <span className="font-medium tabular-nums">{formatMoney(x.source, locale)}</span> →{' '}
                  <span className="tabular-nums">{formatMoney(x.destination, locale)}</span> ·{' '}
                  {x.originCountry} → {x.destinationCountry} · {x.beneficiaryName ?? '—'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('xferAdmin.organization')}: {x.organization?.name ?? x.organizationId} ·{' '}
                  {t('xferAdmin.createdBy')}: {x.createdBy?.email ?? '—'} ·{' '}
                  {formatDate(x.createdAt, locale, true)}
                </p>
                {x.reviewReason ? (
                  <p className="text-xs">
                    <span className="font-medium">{t('xferAdmin.reason')}:</span> {x.reviewReason}
                  </p>
                ) : null}
              </div>
              <TransferReviewButtons transferId={x.id} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{t('xferAdmin.all')}</CardTitle>
              <CardDescription>
                {all.total} {t('xferAdmin.results')}
              </CardDescription>
            </div>
            <TransferFilters basePath="/admin/transfers" status={status} />
          </div>
        </CardHeader>
        <CardContent>
          {all.items.length === 0 ? (
            <EmptyState title={t('common.empty')} description={t('app.sandbox')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('xfer.reference')}</TableHead>
                  <TableHead>{t('xferAdmin.organization')}</TableHead>
                  <TableHead>{t('xferAdmin.createdBy')}</TableHead>
                  <TableHead>{t('xfer.corridor')}</TableHead>
                  <TableHead className="text-right">{t('xfer.amount')}</TableHead>
                  <TableHead className="text-right">{t('xfer.received')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('xferAdmin.score')}</TableHead>
                  <TableHead>{t('common.date')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {all.items.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell>
                      <Link href={`/transfers/${x.id}`} className="font-medium text-primary hover:underline">
                        {x.reference}
                      </Link>
                    </TableCell>
                    <TableCell>{x.organization?.name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{x.createdBy?.email ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {x.originCountry} → {x.destinationCountry}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(x.source, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(x.destination, locale)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={x.status} />
                    </TableCell>
                    <TableCell className="tabular-nums">{x.riskScore ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(x.updatedAt, locale, true)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
