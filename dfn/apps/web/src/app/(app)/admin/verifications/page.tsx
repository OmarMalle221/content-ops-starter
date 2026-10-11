import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { ReviewVerificationButtons } from '@/components/admin/admin-actions';
import { apiFetch } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminVerificationsPage() {
  const [{ t, locale }, data] = await Promise.all([
    getT(),
    apiFetch<any>('/v1/admin/verifications?pageSize=100'),
  ]);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('auth.email')}</TableHead>
          <TableHead>Document</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead>{t('common.date')}</TableHead>
          <TableHead>{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((v: any) => (
          <TableRow key={v.id}>
            <TableCell>
              <p className="font-medium">{v.user.email}</p>
              <p className="text-xs text-muted-foreground">
                {v.user.firstName} {v.user.lastName} · {v.user.country}
              </p>
            </TableCell>
            <TableCell className="text-xs">
              {v.declaredData?.documentType} · {v.declaredData?.issuingCountry}
            </TableCell>
            <TableCell className="text-xs">{v.provider} (simulated)</TableCell>
            <TableCell>
              <StatusBadge status={v.status} />
              {v.reviewNotes ? <p className="mt-1 text-xs text-muted-foreground">{v.reviewNotes}</p> : null}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(v.createdAt, locale, true)}</TableCell>
            <TableCell>
              {['PENDING', 'SIMULATED_FAIL'].includes(v.status) ? (
                <ReviewVerificationButtons id={v.id} />
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
