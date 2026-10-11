import Link from 'next/link';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminDisputesPage() {
  const [{ t, locale }, disputes] = await Promise.all([getT(), apiFetch<any[]>('/v1/disputes')]);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('common.reference')}</TableHead>
          <TableHead>{t('dispute.reason')}</TableHead>
          <TableHead>{t('common.amount')}</TableHead>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead>Assignee</TableHead>
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
            </TableCell>
            <TableCell>{t(`dispute.reasons.${d.reason}`)}</TableCell>
            <TableCell className="tabular-nums">{formatMoney(d.transaction.amount, locale)}</TableCell>
            <TableCell>
              <StatusBadge status={d.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {d.assignedTo ? `${d.assignedTo.firstName} ${d.assignedTo.lastName}` : '—'}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(d.openedAt, locale, true)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
