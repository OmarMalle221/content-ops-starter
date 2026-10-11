import { Download, Lock } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { ReportsPeriodFilter } from '@/components/business/reports-period-filter';
import { StatusBadge } from '@/components/status-badge';
import { apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney, type MoneyDto } from '@/lib/format';
import { DAY_RE, resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Rapports' };

const CURRENCY_RE = /^[A-Z]{3}$/;
const AGING = ['0-30', '31-60', '61-90', '90+'];

interface CountAmount {
  count: number;
  amount: MoneyDto;
}

function StatusTable({
  byStatus,
  locale,
  t,
}: {
  byStatus: Record<string, CountAmount>;
  locale: 'fr' | 'en';
  t: (k: string) => string;
}) {
  const entries = Object.entries(byStatus);
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{t('reportsX.noData')}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead className="text-right">{t('reportsX.count')}</TableHead>
          <TableHead className="text-right">{t('common.amount')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([status, v]) => (
          <TableRow key={status}>
            <TableCell>
              <StatusBadge status={status} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{v.count}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(v.amount, locale)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; from?: string; to?: string; currencyCode?: string }>;
}) {
  const sp = await searchParams;
  const ws = await resolveWorkspace(sp);
  const { t, locale, organizationId } = ws;
  const filters = {
    from: sp.from && DAY_RE.test(sp.from) ? sp.from : undefined,
    to: sp.to && DAY_RE.test(sp.to) ? sp.to : undefined,
    currencyCode: sp.currencyCode && CURRENCY_RE.test(sp.currencyCode) ? sp.currencyCode : undefined,
  };
  if (!ws.canViewReports) {
    return (
      <>
        <BusinessHeader
          ws={ws}
          title={t('reportsX.title')}
          subtitle={t('reportsX.subtitle')}
          basePath="/business/reports"
        />
        <EmptyState icon={<Lock />} title={t('reportsX.noAccess')} description={t('reportsX.noAccessHint')} />
      </>
    );
  }
  const apiQs = new URLSearchParams();
  if (filters.from) apiQs.set('from', filters.from);
  if (filters.to) apiQs.set('to', filters.to);
  if (filters.currencyCode) apiQs.set('currencyCode', filters.currencyCode);
  const suffix = apiQs.size ? `?${apiQs.toString()}` : '';
  const [summary, commissions] = await Promise.all([
    apiFetch<any>(`/v1/organizations/${organizationId}/reports/summary${suffix}`),
    apiFetch<any>(`/v1/organizations/${organizationId}/reports/commissions${suffix}`),
  ]);
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={t('reportsX.title')}
        subtitle={t('reportsX.subtitle')}
        basePath="/business/reports"
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/v1/organizations/${organizationId}/reports/transactions.csv${suffix}`}>
                <Download /> {t('reportsX.exportTransactions')}
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={`/api/v1/organizations/${organizationId}/reports/invoices.csv`}>
                <Download /> {t('reportsX.exportInvoices')}
              </a>
            </Button>
          </>
        }
      />
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('reportsX.period')}</CardTitle>
          <CardDescription>
            {t('reportsX.generatedAt')} {formatDate(summary.generatedAt, locale, true)} · {t('app.sandbox')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReportsPeriodFilter organizationId={organizationId} values={filters} />
        </CardContent>
      </Card>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label={t('reportsX.transactions')} value={summary.counts.transactions} />
        <Stat label={t('reportsX.invoices')} value={summary.counts.invoices} />
        <Stat
          label={t('reportsX.quotes')}
          value={summary.counts.quotes}
          hint={Object.entries(summary.quotesPipeline as Record<string, number>)
            .map(([s, n]) => `${n} ${t(`status.${s}`).toLowerCase()}`)
            .join(' · ')}
        />
      </div>

      {summary.currencies.map((c: any) => (
        <section key={c.currencyCode} className="mb-8 space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{c.currencyCode}</h2>
            <Badge variant="sandbox">{t('app.sandbox')}</Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={t('reportsX.outstanding')}
              value={formatMoney(c.receivables.outstanding, locale)}
              hint={`${c.receivables.outstandingCount} · ${c.receivables.overdueCount} ${t('bizTabs.overdue')}`}
            />
            <Stat
              label={t('reportsX.collected')}
              value={formatMoney(c.receivables.collected, locale)}
              hint={`${t('reportsX.invoiced')}: ${formatMoney(c.receivables.invoiced, locale)}`}
            />
            <Stat
              label={t('reportsX.feesPaid')}
              value={formatMoney(c.protect.feesPaid, locale)}
              hint={`${c.protect.feesCount} ${t('reportsX.transactions').toLowerCase()}`}
            />
            <Stat
              label={t('reportsX.wallet')}
              value={c.wallet ? formatMoney(c.wallet.balance, locale) : '—'}
              hint={c.wallet ? `${c.wallet.entryCount} ${t('reportsX.entries')}` : t('reportsX.noData')}
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>
                  {t('reportsX.protect')} — {t('reportsX.asBuyer')}
                </CardTitle>
                <CardDescription>
                  {t('reportsX.released')}: {formatMoney(c.protect.releasedAsBuyer, locale)} ·{' '}
                  {t('reportsX.refunded')}: {formatMoney(c.protect.refundedAsBuyer, locale)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatusTable byStatus={c.protect.asBuyer.byStatus} locale={locale} t={t} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>
                  {t('reportsX.protect')} — {t('reportsX.asSeller')}
                </CardTitle>
                <CardDescription>
                  {t('reportsX.received')}: {formatMoney(c.protect.receivedAsSeller, locale)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatusTable byStatus={c.protect.asSeller.byStatus} locale={locale} t={t} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('reportsX.aging')}</CardTitle>
                <CardDescription>
                  {t('reportsX.outstanding')}: {formatMoney(c.receivables.outstanding, locale)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('reportsX.bucket')}</TableHead>
                      <TableHead className="text-right">{t('reportsX.count')}</TableHead>
                      <TableHead className="text-right">{t('common.amount')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {AGING.map((b) => (
                      <TableRow key={b}>
                        <TableCell>{b}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.receivables.aging[b].count}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(c.receivables.aging[b].amount, locale)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="mt-4">
                  <StatusTable byStatus={c.receivables.byStatus} locale={locale} t={t} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('reportsX.quotesPipeline')}</CardTitle>
                <CardDescription>
                  {t('reportsX.openValue')}: {formatMoney(c.quotes.openValue, locale)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatusTable byStatus={c.quotes.pipeline} locale={locale} t={t} />
              </CardContent>
            </Card>
          </div>
        </section>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>{t('reportsX.commissions')}</CardTitle>
          <CardDescription>
            {t('reportsX.commissionsHint')}
            {commissions.currencies.length
              ? ` · ${commissions.currencies.map((c: any) => `${c.currencyCode}: ${formatMoney(c.totalFees, locale)}`).join(' · ')}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {commissions.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('reportsX.noCommissions')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.reference')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('reportsX.fundedAt')}</TableHead>
                  <TableHead className="text-right">{t('common.amount')}</TableHead>
                  <TableHead className="text-right">{t('reportsX.feeBps')}</TableHead>
                  <TableHead className="text-right">{t('reportsX.feesPaid')}</TableHead>
                  <TableHead>{t('reportsX.ledgerRef')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commissions.items.map((i: any) => (
                  <TableRow key={i.transactionId}>
                    <TableCell>
                      <a href={`/transactions/${i.transactionId}`} className="font-medium hover:underline">
                        {i.reference}
                      </a>
                      <span className="block max-w-[16rem] truncate text-xs text-muted-foreground">
                        {i.title}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={i.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(i.fundedAt, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(i.amount, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{i.feeBps}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(i.fee, locale)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {i.ledgerTransactionId ? i.ledgerTransactionId.slice(0, 8) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
