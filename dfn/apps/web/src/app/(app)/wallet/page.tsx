import Link from 'next/link';
import { ArrowRight, Download, Users } from 'lucide-react';
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
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { ConversionEstimator } from '@/components/wallet/conversion-estimator';
import { EntriesFilters } from '@/components/wallet/entries-filters';
import { walletQuery } from '@/components/wallet/wallet-query';
import { OrgPicker } from '@/components/wallet/org-picker';
import { SelfDepositDialog } from '@/components/wallet/self-deposit-dialog';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney, type MoneyDto } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Portefeuille' };

interface SummaryCurrency {
  currencyCode: string;
  walletId: string | null;
  balance: MoneyDto;
  entryCount: number;
  recentOperations: unknown[];
  statementPath: string;
  selfDeposit: { limit: MoneyDto; usedToday: MoneyDto; remaining: MoneyDto };
}
interface Summary {
  organizationId: string;
  simulated: boolean;
  currencies: SummaryCurrency[];
  pending: { awaitingFundingAsBuyer: number; escrowsHoldingAsSeller: number };
}
interface Entry {
  id: string;
  signedAmount: MoneyDto;
  kind: string;
  description: string;
  reference: string | null;
  status: string;
  postedAt: string;
}

const KINDS = new Set([
  'DEPOSIT',
  'FUNDING',
  'RELEASE',
  'FEE',
  'REFUND',
  'REVERSAL',
  'ADJUSTMENT',
  'WITHDRAWAL',
]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{
    organizationId?: string;
    currency?: string;
    kind?: string;
    status?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId) ? sp.organizationId : orgs[0].id;
  const currency = (sp.currency ?? 'CAD').toUpperCase();
  const filters = {
    kind: sp.kind && KINDS.has(sp.kind) ? sp.kind : undefined,
    status: sp.status === 'POSTED' || sp.status === 'REVERSED' ? sp.status : undefined,
    from: sp.from && DAY_RE.test(sp.from) ? sp.from : undefined,
    to: sp.to && DAY_RE.test(sp.to) ? sp.to : undefined,
  };
  const entriesQs = new URLSearchParams({ pageSize: '50' });
  if (filters.kind) entriesQs.set('kind', filters.kind);
  if (filters.status) entriesQs.set('status', filters.status);
  if (filters.from) entriesQs.set('from', filters.from);
  if (filters.to) entriesQs.set('to', filters.to);

  const [summary, entries] = await Promise.all([
    apiFetch<Summary>(`/v1/wallets/${organizationId}/summary`),
    apiFetch<{ items: Entry[]; total: number }>(
      `/v1/wallets/${organizationId}/${currency}/entries?${entriesQs.toString()}`,
    ),
  ]);
  const current = summary.currencies.find((c) => c.currencyCode === currency) ?? summary.currencies[0];
  const exportQs = new URLSearchParams(entriesQs);
  exportQs.delete('pageSize');
  const statementHref = `/api/v1/wallets/${organizationId}/${currency}/statement.csv${
    exportQs.size ? `?${exportQs.toString()}` : ''
  }`;
  const pendingTotal = summary.pending.awaitingFundingAsBuyer + summary.pending.escrowsHoldingAsSeller;

  return (
    <>
      <PageHeader
        title={t('wallet.title')}
        subtitle={t('wallet.subtitle')}
        actions={
          <>
            <OrgPicker
              organizations={orgs}
              value={organizationId}
              basePath="/wallet"
              extra={`&currency=${currency}`}
            />
            <Button asChild variant="outline">
              <Link href={`/wallet/beneficiaries?organizationId=${organizationId}`}>
                <Users /> {t('walletPlus.beneficiaries')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/transfers/new?organizationId=${organizationId}`}>
                {t('walletPlus.newTransfer')} <ArrowRight />
              </Link>
            </Button>
            <SelfDepositDialog
              organizationId={organizationId}
              defaultCurrency={currency}
              currencies={summary.currencies.map((c) => ({
                currencyCode: c.currencyCode,
                remaining: c.selfDeposit.remaining,
                limit: c.selfDeposit.limit,
                usedToday: c.selfDeposit.usedToday,
              }))}
            />
          </>
        }
      />
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
        <span>{t('wallet.note')}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {summary.currencies.map((w) => (
          <Link
            key={w.currencyCode}
            href={`/wallet?${walletQuery(organizationId, w.currencyCode)}`}
            className={`rounded-xl ${w.currencyCode === currency ? 'ring-2 ring-primary' : ''}`}
            aria-current={w.currencyCode === currency ? 'page' : undefined}
          >
            <Stat
              label={w.currencyCode}
              value={formatMoney(w.balance, locale)}
              hint={`${w.entryCount} ${t('wallet.entries').toLowerCase()} · ${t('walletPlus.remainingToday').toLowerCase()} ${formatMoney(w.selfDeposit.remaining, locale)}`}
            />
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('walletPlus.pendingTitle')}</CardTitle>
            <CardDescription>{t('walletPlus.pendingDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingTotal === 0 ? (
              <p className="text-sm text-muted-foreground">{t('walletPlus.noPending')}</p>
            ) : null}
            <Link
              href="/transactions?role=BUYER&status=AWAITING_FUNDING"
              className="flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted"
            >
              <span>{t('walletPlus.awaitingFunding')}</span>
              <Badge variant={summary.pending.awaitingFundingAsBuyer ? 'warning' : 'muted'}>
                {summary.pending.awaitingFundingAsBuyer}
              </Badge>
            </Link>
            <Link
              href="/transactions?role=SELLER&status=FUNDED"
              className="flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted"
            >
              <span>{t('walletPlus.escrowsHolding')}</span>
              <Badge variant={summary.pending.escrowsHoldingAsSeller ? 'default' : 'muted'}>
                {summary.pending.escrowsHoldingAsSeller}
              </Badge>
            </Link>
            {current ? (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('walletPlus.recent')} — {current.currencyCode}
                </p>
                {current.recentOperations.length === 0 ? (
                  <p className="mt-1 text-muted-foreground">{t('wallet.empty')}</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {(current.recentOperations as Entry[]).map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-3">
                        <span className="truncate text-muted-foreground">
                          {formatDate(e.postedAt, locale)} · {t(`walletPlus.kinds.${e.kind}`)}
                        </span>
                        <span
                          className={`tabular-nums ${e.signedAmount.minor.startsWith('-') ? 'text-destructive' : 'text-success'}`}
                        >
                          {formatMoney(e.signedAmount, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
        <ConversionEstimator defaultSource={currency} organizationId={organizationId} />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>
              {t('wallet.entries')} — {currency}
            </CardTitle>
            <CardDescription>
              {entries.total} {t('walletPlus.results')} · {t('walletPlus.exportHint')}
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={statementHref}>
              <Download /> {t('wallet.statement')}
            </a>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <EntriesFilters organizationId={organizationId} currency={currency} values={filters} />
          {entries.items.length === 0 ? (
            <EmptyState
              title={
                filters.kind || filters.status || filters.from || filters.to
                  ? t('walletPlus.noMatch')
                  : t('wallet.empty')
              }
              description={t('app.sandbox')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.date')}</TableHead>
                  <TableHead>{t('common.description')}</TableHead>
                  <TableHead>{t('walletPlus.kind')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead className="text-right">{t('common.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(e.postedAt, locale, true)}
                    </TableCell>
                    <TableCell className="max-w-[360px] truncate" title={e.description}>
                      {e.description}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={e.kind} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={e.status} />
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${e.signedAmount.minor.startsWith('-') ? 'text-destructive' : 'text-success'}`}
                    >
                      {formatMoney(e.signedAmount, locale)}
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
