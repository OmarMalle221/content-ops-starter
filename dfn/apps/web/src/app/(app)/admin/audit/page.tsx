import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { apiFetch } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminAuditPage() {
  const [{ t, locale }, data] = await Promise.all([
    getT(),
    apiFetch<any>('/v1/admin/audit-logs?pageSize=100'),
  ]);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('common.date')}</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Entity</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>IP</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((l: any) => (
          <TableRow key={l.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {formatDate(l.createdAt, locale, true)}
            </TableCell>
            <TableCell className="font-mono text-xs">{l.action}</TableCell>
            <TableCell className="font-mono text-xs">
              {l.entityType} {l.entityId ? `· ${l.entityId.slice(0, 8)}` : ''}
            </TableCell>
            <TableCell className="text-xs">{l.actor?.email ?? 'system'}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{l.ip ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
