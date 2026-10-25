import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { formatDate } from '@/lib/format';
import type { Locale } from '@/lib/i18n';

/** A JobLease row as returned by GET /v1/admin/jobs (`expired` is computed with the DB clock). */
export interface JobLease {
  jobName: string;
  ownerId: string;
  runId: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  expired: boolean;
}

/**
 * Deterministic UTC timestamp with seconds (heartbeats are a few seconds apart). No Intl and no
 * clock read: server rendering and hydration produce the same string.
 */
export function formatTimestamp(value: string | null | undefined, locale: Locale): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${formatDate(date, locale)} ${time} UTC`;
}

/**
 * Current job leases (server component): which instance runs which job, its last heartbeat and
 * when the lease expires. Read-only — leases are managed by the runners, never by hand.
 */
export function JobLeasesCard({
  leases,
  instanceId,
  locale,
  t,
  jobLabel,
}: {
  leases: JobLease[];
  instanceId: string;
  locale: Locale;
  t: (key: string) => string;
  jobLabel: (name: string) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('jobsAdmin.leases')}</CardTitle>
        <CardDescription>{t('jobsAdmin.leasesDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {leases.length === 0 ? (
          <EmptyState title={t('jobsAdmin.noLeases')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('jobsAdmin.job')}</TableHead>
                <TableHead>{t('jobsAdmin.owner')}</TableHead>
                <TableHead>{t('jobsAdmin.acquiredAt')}</TableHead>
                <TableHead>{t('jobsAdmin.heartbeatAt')}</TableHead>
                <TableHead>{t('jobsAdmin.expiresAt')}</TableHead>
                <TableHead>{t('jobsAdmin.leaseState')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leases.map((lease) => (
                <TableRow key={lease.jobName}>
                  <TableCell>
                    <p className="font-medium">{jobLabel(lease.jobName)}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {t('jobsAdmin.run')} {lease.runId ? lease.runId.slice(0, 8) : '—'}
                    </p>
                  </TableCell>
                  <TableCell>
                    <p className="break-all font-mono text-xs">{lease.ownerId}</p>
                    {lease.ownerId === instanceId ? (
                      <Badge variant="secondary" className="mt-1">
                        {t('jobsAdmin.thisInstance')}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatTimestamp(lease.acquiredAt, locale)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatTimestamp(lease.heartbeatAt, locale)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatTimestamp(lease.expiresAt, locale)}
                  </TableCell>
                  <TableCell>
                    {lease.expired ? (
                      <Badge variant="warning">{t('jobsAdmin.leaseExpired')}</Badge>
                    ) : (
                      <Badge variant="success">{t('jobsAdmin.leaseActive')}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
