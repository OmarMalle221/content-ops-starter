import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { UserRoleSelect, UserStatusButton } from '@/components/admin/admin-actions';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const sp = await searchParams;
  const [{ t, locale }, session, data] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any>(
      `/v1/admin/users?pageSize=100${sp.search ? `&search=${encodeURIComponent(sp.search)}` : ''}`,
    ),
  ]);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('auth.email')}</TableHead>
          <TableHead>{t('common.name')}</TableHead>
          <TableHead>{t('common.role')}</TableHead>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead>KYC</TableHead>
          <TableHead>MFA</TableHead>
          <TableHead>{t('common.created')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((u: any) => (
          <TableRow key={u.id}>
            <TableCell className="font-medium">{u.email}</TableCell>
            <TableCell>
              {u.firstName} {u.lastName} <span className="text-xs text-muted-foreground">{u.country}</span>
            </TableCell>
            <TableCell>{u.id === session!.user.id ? u.globalRole : <UserRoleSelect user={u} />}</TableCell>
            <TableCell>
              <StatusBadge status={u.status} />
            </TableCell>
            <TableCell>
              <StatusBadge status={u.identityStatus} />
            </TableCell>
            <TableCell>{u.mfaEnabled ? '✓' : '—'}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(u.createdAt, locale)}</TableCell>
            <TableCell>{u.id !== session!.user.id ? <UserStatusButton user={u} /> : null}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
