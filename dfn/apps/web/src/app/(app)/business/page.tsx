import Link from 'next/link';
import { ArrowRight, FileText, Link2 } from 'lucide-react';
import { minorToDecimalString } from '@dfn/shared';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Stat } from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { DocumentsTable } from '@/components/business/documents-table';
import { apiFetch } from '@/lib/api-server';
import { formatMoney, type MoneyDto } from '@/lib/format';
import { resolveWorkspace } from './_shared/workspace';

export const metadata = { title: 'Entreprise' };

const OPEN = new Set(['SENT', 'PARTIALLY_PAID', 'OVERDUE']);

export default async function BusinessPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const ws = await resolveWorkspace(searchParams);
  const { t, locale, organizationId, qs } = ws;
  const [txs, wallet, invoices, quotes, linkRequests] = await Promise.all([
    apiFetch<any>(`/v1/transactions?organizationId=${organizationId}&pageSize=100`),
    apiFetch<any>(`/v1/wallets/${organizationId}`),
    apiFetch<any>(`/v1/invoices?organizationId=${organizationId}&pageSize=100`),
    apiFetch<any>(`/v1/quotes?organizationId=${organizationId}&status=SENT,ACCEPTED&pageSize=100`),
    // Link requests received (consent): OWNER / ADMIN only.
    ws.canDecideLinks
      ? apiFetch<{ items: unknown[] }>(`/v1/organizations/${organizationId}/link-requests?status=PENDING`)
      : Promise.resolve({ items: [] as unknown[] }),
  ]);
  const pendingLinks = linkRequests.items.length;
  const active = txs.items.filter(
    (x: any) => !['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'].includes(x.status),
  ).length;
  const disputed = txs.items.filter((x: any) => x.openDisputes > 0).length;
  // Outstanding receivables per currency (integer math on minor units)
  const outstanding = new Map<string, bigint>();
  let overdue = 0;
  for (const inv of invoices.items as any[]) {
    if (!OPEN.has(inv.status)) continue;
    outstanding.set(
      inv.currencyCode,
      (outstanding.get(inv.currencyCode) ?? 0n) + BigInt(inv.balanceDue.minor),
    );
    if (inv.status === 'OVERDUE') overdue += 1;
  }
  const mainCcy = outstanding.has('CAD') ? 'CAD' : ([...outstanding.keys()][0] ?? 'CAD');
  const outstandingMinor = outstanding.get(mainCcy) ?? 0n;
  const outstandingMoney: MoneyDto = {
    minor: outstandingMinor.toString(),
    decimal: minorToDecimalString(outstandingMinor, mainCcy),
    currency: mainCcy,
  };
  const cad = wallet.wallets.find((w: any) => w.currencyCode === 'CAD');
  const recent = (invoices.items as any[]).slice(0, 5);
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={t('business.title')}
        subtitle={t('business.subtitle')}
        basePath="/business"
      />
      {pendingLinks > 0 ? (
        <Card className="mb-6 border-primary/40">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-4 w-4" /> {t('counterpartyLinks.received')}
              </CardTitle>
              <CardDescription>
                {pendingLinks} {t('counterpartyLinks.pending')} · {t('counterpartyLinks.receivedHint')}
              </CardDescription>
            </div>
            <Button asChild size="sm">
              <Link href={`/business/links?${qs}`}>
                {t('counterpartyLinks.review')} <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
        </Card>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('nav.transactions')}
          value={txs.total}
          hint={`${active} ${t('status.IN_PROGRESS').toLowerCase()} · ${disputed} ${t('nav.disputes').toLowerCase()}`}
        />
        <Stat
          label={t('bizTabs.outstanding')}
          value={formatMoney(outstandingMoney, locale)}
          hint={`${overdue} ${t('bizTabs.overdue')} · ${t('app.sandbox')}`}
        />
        <Stat label={t('bizTabs.openQuotes')} value={quotes.total} hint={t('quotesX.expiredHint')} />
        <Stat
          label={`${t('bizTabs.walletBalance')} CAD`}
          value={cad ? formatMoney(cad.balance, locale) : '—'}
          hint={t('app.sandbox')}
        />
      </div>
      <Card className="mt-6">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>{t('bizTabs.recentInvoices')}</CardTitle>
            <CardDescription>{t('app.sandbox')}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/business/quotes?${qs}`}>
                {t('bizTabs.seeQuotes')} <ArrowRight />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/business/invoices?${qs}`}>
                {t('bizTabs.seeInvoices')} <ArrowRight />
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title={t('invoicing.empty')}
              description={t('invoicing.emptyHint')}
            />
          ) : (
            <DocumentsTable
              kind="INVOICE"
              rows={recent}
              organizationId={organizationId}
              locale={locale}
              t={t}
            />
          )}
        </CardContent>
      </Card>
      {ws.org.type !== 'BUSINESS' ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('bizTabs.noBusiness')}</p>
      ) : null}
    </>
  );
}
