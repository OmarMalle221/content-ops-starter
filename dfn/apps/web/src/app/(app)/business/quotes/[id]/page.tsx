import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { PrintableDocument } from '@/components/business/printable-document';
import { QuoteActions } from '@/components/business/quote-actions';
import { StatusBadge } from '@/components/status-badge';
import { ApiError, apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { isoDateInDays, resolveWorkspace } from '../../_shared/workspace';

export const metadata = { title: 'Devis' };

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const { id } = await params;
  let quote: any;
  let document: any;
  try {
    [quote, document] = await Promise.all([
      apiFetch<any>(`/v1/quotes/${id}`),
      apiFetch<any>(`/v1/quotes/${id}/document`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const sp = await searchParams;
  const ws = await resolveWorkspace({
    organizationId:
      quote.myRole === 'CUSTOMER'
        ? (quote.counterparty?.linkedOrganizationId ?? sp.organizationId)
        : quote.organizationId,
  });
  const { t, locale, organizationId, qs } = ws;
  const counterparties =
    quote.myRole === 'ISSUER' && ws.canInvoice && quote.status === 'DRAFT'
      ? await apiFetch<any[]>(`/v1/organizations/${quote.organizationId}/counterparties`)
      : [];
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={`${t('quotesX.detail')} ${quote.number}`}
        subtitle={`${quote.customerName} · ${formatMoney(quote.total, locale)}`}
        basePath="/business/quotes"
        actions={
          <Button asChild variant="ghost">
            <Link href={`/business/quotes?${qs}`}>
              <ArrowLeft /> {t('quotesX.back')}
            </Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={quote.status} />
        <Badge variant="outline">{t(`invoicing.role.${quote.myRole}`)}</Badge>
        {quote.invoice ? (
          <Link
            href={`/business/invoices/${quote.invoice.id}?${qs}`}
            className="text-sm text-primary hover:underline"
          >
            {t('quotesX.convertedInvoice')}: {quote.invoice.number}
          </Link>
        ) : null}
      </div>

      <QuoteActions
        quote={quote}
        organizationId={organizationId}
        counterparties={counterparties}
        defaultDueDate={isoDateInDays(30)}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('invoicing.lines')}</CardTitle>
            <CardDescription>{t('app.sandbox')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>{t('invoicing.description')}</TableHead>
                  <TableHead className="text-right">{t('invoicing.quantity')}</TableHead>
                  <TableHead className="text-right">{t('invoicing.unitPrice')}</TableHead>
                  <TableHead className="text-right">{t('invoicing.lineTotal')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quote.lines.map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.position}</TableCell>
                    <TableCell>{l.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(l.unitPrice, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.total, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-1 text-sm">
              <dt className="text-muted-foreground">{t('invoicing.subtotal')}</dt>
              <dd className="text-right tabular-nums">{formatMoney(quote.subtotal, locale)}</dd>
              <dt className="text-muted-foreground">
                {t('invoicing.tax')} ({(quote.taxBps / 100).toFixed(2)} %)
              </dt>
              <dd className="text-right tabular-nums">{formatMoney(quote.tax, locale)}</dd>
              <dt className="font-medium">{t('invoicing.total')}</dt>
              <dd className="text-right font-semibold tabular-nums">{formatMoney(quote.total, locale)}</dd>
            </dl>
            {quote.notes ? (
              <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{quote.notes}</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('common.details')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">{t('invoicing.issuer')}</dt>
              <dd>{quote.issuer.legalName ?? quote.issuer.name}</dd>
              <dt className="text-muted-foreground">{t('invoicing.customer')}</dt>
              <dd>
                {quote.customerName}
                {quote.customerEmail ? (
                  <span className="block text-xs text-muted-foreground">{quote.customerEmail}</span>
                ) : null}
              </dd>
              <dt className="text-muted-foreground">{t('invoicing.currency')}</dt>
              <dd>{quote.currencyCode}</dd>
              <dt className="text-muted-foreground">{t('common.created')}</dt>
              <dd>{formatDate(quote.createdAt, locale)}</dd>
              <dt className="text-muted-foreground">{t('quotesX.validUntil')}</dt>
              <dd>{formatDate(quote.validUntil, locale)}</dd>
              <dt className="text-muted-foreground">{t('invoicing.sentAt')}</dt>
              <dd>{formatDate(quote.sentAt, locale, true)}</dd>
              <dt className="text-muted-foreground">{t('quotesX.acceptedAt')}</dt>
              <dd>{formatDate(quote.acceptedAt, locale, true)}</dd>
              {quote.declinedAt ? (
                <>
                  <dt className="text-muted-foreground">{t('quotesX.declinedAt')}</dt>
                  <dd>{formatDate(quote.declinedAt, locale, true)}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('invoicing.printable')}</CardTitle>
          <CardDescription>{t('app.sandbox')}</CardDescription>
        </CardHeader>
        <CardContent>
          <PrintableDocument text={document.text} />
        </CardContent>
      </Card>
    </>
  );
}
