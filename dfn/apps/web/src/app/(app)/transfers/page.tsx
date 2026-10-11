import Link from 'next/link';
import { ArrowRight, Send, Users } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { TransferFilters } from '@/components/transfers/transfer-filters';
import { TRANSFER_STATUSES, type TransferSummaryDto } from '@/components/transfers/types';
import { OrgPicker } from '@/components/wallet/org-picker';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Transferts' };

const PAGE_SIZE = 25;
const STATUSES = new Set<string>(TRANSFER_STATUSES);

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId) ? sp.organizationId : orgs[0].id;
  const status = sp.status && STATUSES.has(sp.status) ? sp.status : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const qs = new URLSearchParams({ organizationId, page: String(page), pageSize: String(PAGE_SIZE) });
  if (status) qs.set('status', status);
  const data = await apiFetch<{ items: TransferSummaryDto[]; total: number; page: number; pageSize: number }>(
    `/v1/transfers?${qs.toString()}`,
  );
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pageHref = (p: number) => {
    const q = new URLSearchParams({ organizationId, page: String(p) });
    if (status) q.set('status', status);
    return `/transfers?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={t('xfer.title')}
        subtitle={t('xfer.subtitle')}
        actions={
          <>
            <OrgPicker
              organizations={orgs}
              value={organizationId}
              basePath="/transfers"
              extra={status ? `&status=${status}` : ''}
            />
            <Button asChild variant="outline">
              <Link href={`/wallet/beneficiaries?organizationId=${organizationId}`}>
                <Users /> {t('walletPlus.beneficiaries')}
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/transfers/new?organizationId=${organizationId}`}>
                <Send /> {t('xfer.new')}
              </Link>
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <TransferFilters basePath="/transfers" organizationId={organizationId} status={status} />
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
        <span className="text-sm text-muted-foreground">
          {data.total} {t('xfer.results')}
        </span>
      </div>
      {data.items.length === 0 ? (
        <EmptyState
          icon={<Send />}
          title={t('xfer.empty')}
          description={status ? t('app.sandbox') : t('xfer.emptyHint')}
          action={
            <Button asChild>
              <Link href={`/transfers/new?organizationId=${organizationId}`}>{t('xfer.new')}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('xfer.reference')}</TableHead>
                <TableHead>{t('xfer.beneficiary')}</TableHead>
                <TableHead>{t('xfer.corridor')}</TableHead>
                <TableHead className="text-right">{t('xfer.amount')}</TableHead>
                <TableHead className="text-right">{t('xfer.received')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('xfer.createdAt')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((x) => (
                <TableRow key={x.id}>
                  <TableCell>
                    <Link href={`/transfers/${x.id}`} className="font-medium text-primary hover:underline">
                      {x.reference}
                    </Link>
                  </TableCell>
                  <TableCell>{x.beneficiaryName ?? '—'}</TableCell>
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
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDate(x.createdAt, locale, true)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm">
              {page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={pageHref(page - 1)}>{t('xfer.previous')}</Link>
                </Button>
              ) : (
                <span />
              )}
              <span className="text-muted-foreground">
                {t('xfer.page')} {page} / {totalPages}
              </span>
              {page < totalPages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={pageHref(page + 1)}>
                    {t('xfer.next')} <ArrowRight />
                  </Link>
                </Button>
              ) : (
                <span />
              )}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
