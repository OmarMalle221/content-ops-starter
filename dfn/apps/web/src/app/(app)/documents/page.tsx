import Link from 'next/link';
import { FileText } from 'lucide-react';
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { UploadDocumentDialog } from '@/components/transactions/upload-dialog';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const [{ t, locale }, session, docs] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any[]>('/v1/documents'),
  ]);
  const personal =
    session!.user.organizations.find((o) => o.type === 'PERSONAL') ?? session!.user.organizations[0];
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
                <TableCell className="text-muted-foreground">{formatDate(d.createdAt, locale)}</TableCell>
                <TableCell className="text-right">
                  <a
                    className="text-sm text-primary hover:underline"
                    href={`/api/v1/documents/${d.id}/download`}
                  >
                    {t('common.download')}
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
