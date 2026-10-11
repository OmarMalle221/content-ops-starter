import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
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
import { InvoiceActions } from '@/components/business/invoice-actions';
import { PrintableDocument } from '@/components/business/printable-document';
import { StatusBadge } from '@/components/status-badge';
import { ApiError, apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { resolveWorkspace } from '../../_shared/workspace';

export const metadata = { title: 'Facture' };

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const { id } = await params;
  let invoice: any;
  let document: any;
  try {
    [invoice, document] = await Promise.all([
      apiFetch<any>(`/v1/invoices/${id}`),
      apiFetch<any>(`/v1/invoices/${id}/document`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  // The invoice decides the organisation context (issuer, or the linked customer organisation).
  const sp = await searchParams;
  const ws = await resolveWorkspace({
    organizationId:
      invoice.myRole === 'CUSTOMER'
        ? (invoice.counterparty?.linkedOrganizationId ?? sp.organizationId)
        : invoice.organizationId,
  });
  const { t, locale, organizationId, qs } = ws;
  const counterparties =
    invoice.myRole === 'ISSUER' && ws.canInvoice && invoice.status === 'DRAFT'
      ? await apiFetch<any[]>(`/v1/organizations/${invoice.organizationId}/counterparties`)
      : [];
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={`${t('invoicing.detail')} ${invoice.number}`}
        subtitle={`${invoice.customerName} · ${formatMoney(invoice.total, locale)}`}
        basePath="/business/invoices"
        actions={
          <Button asChild variant="ghost">
            <Link href={`/business/invoices?${qs}`}>
              <ArrowLeft /> {t('invoicing.back')}
            </Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={invoice.status} />
        <Badge variant="outline">{t(`invoicing.role.${invoice.myRole}`)}</Badge>
        {invoice.quote ? (
          <Link
            href={`/business/quotes/${invoice.quote.id}?${qs}`}
            className="text-sm text-primary hover:underline"
          >
            {t('invoicing.fromQuote')} {invoice.quote.number}
          </Link>
        ) : null}
        {invoice.transaction ? (
          <Link
            href={`/transactions/${invoice.transaction.id}`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t('invoicing.linkedTransaction')} {invoice.transaction.reference}{' '}
            <ExternalLink className="size-3" />
          </Link>
        ) : null}
      </div>

      <InvoiceActions invoice={invoice} organizationId={organizationId} counterparties={counterparties} />

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
                {invoice.lines.map((l: any) => (
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
              <dd className="text-right tabular-nums">{formatMoney(invoice.subtotal, locale)}</dd>
              <dt className="text-muted-foreground">
                {t('invoicing.tax')} ({(invoice.taxBps / 100).toFixed(2)} %)
              </dt>
              <dd className="text-right tabular-nums">{formatMoney(invoice.tax, locale)}</dd>
              <dt className="font-medium">{t('invoicing.total')}</dt>
              <dd className="text-right font-semibold tabular-nums">{formatMoney(invoice.total, locale)}</dd>
              <dt className="text-muted-foreground">{t('invoicing.paid')}</dt>
              <dd className="text-right tabular-nums">{formatMoney(invoice.paid, locale)}</dd>
              <dt className="font-medium">{t('invoicing.balanceDue')}</dt>
              <dd className="text-right font-semibold tabular-nums">
                {formatMoney(invoice.balanceDue, locale)}
              </dd>
            </dl>
            {invoice.notes ? (
              <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{invoice.notes}</p>
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
              <dd>{invoice.issuer.legalName ?? invoice.issuer.name}</dd>
              <dt className="text-muted-foreground">{t('invoicing.customer')}</dt>
              <dd>
                {invoice.customerName}
                {invoice.customerEmail ? (
                  <span className="block text-xs text-muted-foreground">{invoice.customerEmail}</span>
                ) : null}
              </dd>
              <dt className="text-muted-foreground">{t('invoicing.currency')}</dt>
              <dd>{invoice.currencyCode}</dd>
              <dt className="text-muted-foreground">{t('invoicing.issueDate')}</dt>
              <dd>{formatDate(invoice.issueDate, locale)}</dd>
              <dt className="text-muted-foreground">{t('invoicing.dueDate')}</dt>
              <dd>{formatDate(invoice.dueDate, locale)}</dd>
              <dt className="text-muted-foreground">{t('invoicing.sentAt')}</dt>
              <dd>{formatDate(invoice.sentAt, locale, true)}</dd>
              <dt className="text-muted-foreground">{t('invoicing.paidAt')}</dt>
              <dd>{formatDate(invoice.paidAt, locale, true)}</dd>
              {invoice.cancelledAt ? (
                <>
                  <dt className="text-muted-foreground">{t('invoicing.cancelledAt')}</dt>
                  <dd>{formatDate(invoice.cancelledAt, locale, true)}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('invoicing.payments')}</CardTitle>
          <CardDescription>{t('invoicing.protectAuto')}</CardDescription>
        </CardHeader>
        <CardContent>
          {invoice.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('invoicing.noPayments')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.date')}</TableHead>
                  <TableHead>{t('invoicing.paymentMethod')}</TableHead>
                  <TableHead>{t('invoicing.reference')}</TableHead>
                  <TableHead>{t('invoicing.recordedBy')}</TableHead>
                  <TableHead className="text-right">{t('invoicing.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.payments.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{formatDate(p.paidAt, locale, true)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`invoicing.methods.${p.method}`)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate font-mono text-xs">
                      {p.reference ?? p.ledgerTransactionId ?? '—'}
                    </TableCell>
                    <TableCell>
                      {p.recordedBy ? `${p.recordedBy.firstName} ${p.recordedBy.lastName}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(p.amount, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
