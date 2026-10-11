import Link from 'next/link';
import { Download } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { OrgPicker } from '@/components/wallet/org-picker';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Portefeuille' };

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; currency?: string }>;
}) {
  const sp = await searchParams;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId) ? sp.organizationId : orgs[0].id;
  const currency = (sp.currency ?? 'CAD').toUpperCase();
  const [balances, entries] = await Promise.all([
    apiFetch<any>(`/v1/wallets/${organizationId}`),
    apiFetch<any>(`/v1/wallets/${organizationId}/${currency}/entries?pageSize=50`),
  ]);
  return (
    <>
      <PageHeader
        title={t('wallet.title')}
        subtitle={t('wallet.subtitle')}
        actions={<OrgPicker organizations={orgs} value={organizationId} basePath="/wallet" />}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {balances.wallets.map((w: any) => (
          <Link
            key={w.currencyCode}
            href={`/wallet?organizationId=${organizationId}&currency=${w.currencyCode}`}
            className={w.currencyCode === currency ? 'ring-2 ring-primary rounded-xl' : ''}
          >
            <Stat
              label={w.currencyCode}
              value={formatMoney(w.balance, locale)}
              hint={`${w.entryCount} ${t('wallet.entries').toLowerCase()}`}
            />
          </Link>
        ))}
      </div>
      <Card className="mt-6">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>
              {t('wallet.entries')} — {currency}
            </CardTitle>
            <CardDescription>{t('wallet.note')}</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/wallets/${organizationId}/${currency}/statement.csv`}>
              <Download /> {t('wallet.statement')}
            </a>
          </Button>
        </CardHeader>
        <CardContent>
          {entries.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('wallet.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.date')}</TableHead>
                  <TableHead>{t('common.description')}</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead className="text-right">{t('common.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.items.map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(e.postedAt, locale, true)}
                    </TableCell>
                    <TableCell className="max-w-[360px] truncate">{e.description}</TableCell>
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
