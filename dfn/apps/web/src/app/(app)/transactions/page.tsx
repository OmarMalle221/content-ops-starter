import Link from 'next/link';
import { ArrowLeftRight } from 'lucide-react';
import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { TransactionsFilters } from '@/components/transactions/filters';
import { apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Transactions' };

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; status?: string; search?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const qs = new URLSearchParams();
  if (sp.role) qs.set('role', sp.role);
  if (sp.status) qs.set('status', sp.status);
  if (sp.search) qs.set('search', sp.search);
  qs.set('page', sp.page ?? '1');
  qs.set('pageSize', '25');
  const data = await apiFetch<any>(`/v1/transactions?${qs.toString()}`);
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <>
      <PageHeader
        title={t('tx.list')}
        subtitle={t('app.sandbox')}
        actions={
          <Button asChild>
            <Link href="/transactions/new">{t('nav.newTransaction')}</Link>
          </Button>
        }
      />
      <TransactionsFilters role={sp.role} status={sp.status} search={sp.search} />
      {data.items.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={<ArrowLeftRight />}
          title={t('dashboard.noTransactions')}
          description={t('dashboard.createFirst')}
          action={
            <Button asChild>
              <Link href="/transactions/new">{t('nav.newTransaction')}</Link>
            </Button>
          }
        />
      ) : (
        <div className="mt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.reference')}</TableHead>
                <TableHead>{t('tx.title')}</TableHead>
                <TableHead>{t('common.role')}</TableHead>
                <TableHead>{t('tx.counterpart')}</TableHead>
                <TableHead className="text-right">{t('common.amount')}</TableHead>
                <TableHead>{t('tx.progress')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('common.updated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((x: any) => (
                <TableRow key={x.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/transactions/${x.id}`} className="text-primary hover:underline">
                      {x.reference}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate font-medium">
                    <Link href={`/transactions/${x.id}`}>{x.title}</Link>
                  </TableCell>
                  <TableCell>{t(`roles.${x.myRole}`)}</TableCell>
                  <TableCell className="text-muted-foreground">{x.counterpart?.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(x.amount, locale)}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {x.milestoneProgress.released}/{x.milestoneProgress.total}
                    {x.openDisputes ? <span className="ml-2 text-destructive">⚠</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={x.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(x.updatedAt, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 ? (
            <div className="mt-3 flex items-center justify-end gap-2 text-sm">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/transactions?${new URLSearchParams({ ...sp, page: String(p) }).toString()}`}
                  className={p === data.page ? 'font-semibold text-primary' : 'text-muted-foreground'}
                >
                  {p}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
