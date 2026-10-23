import Link from 'next/link';
import { FileText } from 'lucide-react';
import { DocumentPurgeState, type DocumentPurgeDto } from '@dfn/shared';
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
import { ScanBadge } from '@/components/documents/scan-badge';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { UploadDocumentDialog } from '@/components/transactions/upload-dialog';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';
import { apiHref } from '@/lib/api-href';

export const metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const [{ t, locale }, session, docs, deleted] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any[]>('/v1/documents'),
    apiFetch<any[]>('/v1/documents/deleted'),
  ]);
  const personal =
    session!.user.organizations.find((o) => o.type === 'PERSONAL') ?? session!.user.organizations[0];
  const purgeLabel = (purge: DocumentPurgeDto) =>
    purge.state === DocumentPurgeState.PURGED
      ? t('documentStorage.purge.PURGED').replace('{date}', formatDate(purge.purgedAt, locale))
      : t('documentStorage.purge.RETAINED').replace('{date}', formatDate(purge.purgeAfter, locale));
  return (
    <>
      <PageHeader
        title={t('docs.title')}
        subtitle={t('docs.encrypted')}
        actions={<UploadDocumentDialog organizationId={personal?.id} variant="default" />}
      />
      {docs.length === 0 ? (
        <EmptyState icon={<FileText />} title={t('common.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('tx.title')}</TableHead>
              <TableHead>{t('docs.kind')}</TableHead>
              <TableHead>{t('docs.linkedTx')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('documentStorage.scan.column')}</TableHead>
              <TableHead>{t('common.date')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-medium">{d.title}</TableCell>
                <TableCell>{t(`docs.kinds.${d.kind}`)}</TableCell>
                <TableCell>
                  {d.transaction ? (
                    <Link href={`/transactions/${d.transaction.id}`} className="text-primary hover:underline">
                      {d.transaction.reference}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={d.status} />
                </TableCell>
                <TableCell>
                  <ScanBadge scan={d.scan} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(d.createdAt, locale)}</TableCell>
                <TableCell className="text-right">
                  {d.downloadUrl ? (
                    <a className="text-sm text-primary hover:underline" href={apiHref(d.downloadUrl)}>
                      {t('common.download')}
                    </a>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t('documentStorage.scan.blocked')}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {deleted.length > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{t('documentStorage.deleted.title')}</CardTitle>
            <CardDescription>{t('documentStorage.deleted.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('tx.title')}</TableHead>
                  <TableHead>{t('docs.kind')}</TableHead>
                  <TableHead>{t('documentStorage.deleted.deletedAt')}</TableHead>
                  <TableHead>{t('documentStorage.deleted.file')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deleted.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.title}</TableCell>
                    <TableCell>{t(`docs.kinds.${d.kind}`)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(d.purge.deletedAt, locale)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={d.purge.state === DocumentPurgeState.PURGED ? 'secondary' : 'muted'}>
                          {purgeLabel(d.purge)}
                        </Badge>
                        {d.purge.heldAsEvidence && d.purge.state === DocumentPurgeState.RETAINED ? (
                          <Badge variant="warning">{t('documentStorage.purge.held')}</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
