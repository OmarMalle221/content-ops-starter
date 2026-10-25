import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { formatDate, formatMoney, type MoneyDto } from '@/lib/format';
import type { Locale } from '@/lib/i18n';

export interface DocumentRow {
  id: string;
  number: string;
  status: string;
  customerName: string;
  currencyCode: string;
  total: MoneyDto;
  balanceDue?: MoneyDto;
  dueDate?: string;
  validUntil?: string;
  myRole?: string;
  issuer?: { name: string };
}

/** Server-rendered list of invoices or quotes (deterministic formatting, no Intl). */
export function DocumentsTable({
  kind,
  rows,
  organizationId,
  locale,
  t,
  compact = false,
}: {
  kind: 'INVOICE' | 'QUOTE';
  rows: DocumentRow[];
  organizationId: string;
  locale: Locale;
  t: (k: string) => string;
  compact?: boolean;
}) {
  const base = kind === 'INVOICE' ? '/business/invoices' : '/business/quotes';
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('invoicing.number')}</TableHead>
          <TableHead>{t('invoicing.customer')}</TableHead>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead>{kind === 'INVOICE' ? t('invoicing.dueDate') : t('quotesX.validUntil')}</TableHead>
          <TableHead className="text-right">{t('invoicing.total')}</TableHead>
          {kind === 'INVOICE' && !compact ? (
            <TableHead className="text-right">{t('invoicing.balanceDue')}</TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link
                href={`${base}/${r.id}?organizationId=${organizationId}`}
                className="font-medium hover:underline"
              >
                {r.number}
              </Link>
              {r.myRole === 'CUSTOMER' && r.issuer ? (
                <span className="block text-xs text-muted-foreground">{r.issuer.name}</span>
              ) : null}
            </TableCell>
            <TableCell className="max-w-[12rem] truncate">{r.customerName}</TableCell>
            <TableCell>
              <StatusBadge status={r.status} entity={kind === 'INVOICE' ? 'invoice' : 'quote'} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {formatDate(r.dueDate ?? r.validUntil, locale)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(r.total, locale)}</TableCell>
            {kind === 'INVOICE' && !compact ? (
              <TableCell className="text-right tabular-nums">{formatMoney(r.balanceDue, locale)}</TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
