import Link from 'next/link';
import { Scale } from 'lucide-react';
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Litiges' };

export default async function DisputesPage() {
  const [{ t, locale }, disputes] = await Promise.all([getT(), apiFetch<any[]>('/v1/disputes')]);
  return (
    <>
      <PageHeader title={t('dispute.title')} subtitle={t('dispute.frozen')} />
      {disputes.length === 0 ? (
        <EmptyState icon={<Scale />} title={t('common.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.reference')}</TableHead>
              <TableHead>{t('dispute.reason')}</TableHead>
              <TableHead>{t('common.amount')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('common.date')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {disputes.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link href={`/disputes/${d.id}`} className="font-medium text-primary hover:underline">
                    {d.transaction.reference}
                  </Link>
                  <p className="text-xs text-muted-foreground">{d.transaction.title}</p>
                </TableCell>
                <TableCell>{t(`dispute.reasons.${d.reason}`)}</TableCell>
                <TableCell className="tabular-nums">{formatMoney(d.transaction.amount, locale)}</TableCell>
                <TableCell>
                  <StatusBadge status={d.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(d.openedAt, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
