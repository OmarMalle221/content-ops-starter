import Link from 'next/link';
import { DocumentReviewForm } from '@/components/admin/forms';
import { PageHeader, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { OpenDocumentButton } from '@/components/tx/document-open';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtDate, shortHash } from '@/lib/format';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function DocumentsAdmin() {
    const actor = await requireStaff(['document_reviewer', 'compliance_analyst'], '/admin/documents');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.admin.listDocumentsToReview(actor);
    const reviewer = hasRole(actor, 'document_reviewer');
    return (
        <>
            <PageHeader title={t('nav.documents')} />
            <Alert tone="info" className="mb-6">
                {t('documents.comparisonHint')}
            </Alert>
            <Card>
                <Table>
                    <THead>
                        <tr>
                            <TH>{t('documents.title')}</TH>
                            <TH>{t('common.reference')}</TH>
                            <TH>{t('documents.declared')}</TH>
                            <TH>{t('common.status')}</TH>
                            <TH>{t('common.actions')}</TH>
                        </tr>
                    </THead>
                    <TBody>
                        {list.map(({ document: d, reference }) => (
                            <TR key={d.id}>
                                <TD>
                                    <p className="font-medium">
                                        {t(`documentType.${d.type}`)} — {d.title}{' '}
                                        <span className="text-xs text-muted-foreground">v{d.version}</span>
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {fmtDate(d.uploadedAt, intl, true)} · <Mono>{shortHash(d.sha256)}</Mono> · scan: {d.scan.status}
                                    </p>
                                </TD>
                                <TD>
                                    {reference && (
                                        <Link
                                            href={`/admin/transactions/${d.transactionId}?tab=documents`}
                                            className="font-mono text-xs text-primary hover:underline"
                                        >
                                            {reference}
                                        </Link>
                                    )}
                                </TD>
                                <TD className="max-w-64 text-xs break-words">
                                    {Object.entries(d.extracted)
                                        .map(([k, v]) => `${k}: ${typeof v === 'object' ? `${v.amountMinor} ${v.currency}` : v}`)
                                        .join(' · ') || '—'}
                                </TD>
                                <TD>
                                    <ToneBadge tone={toneFor(d.status)}>{t(`documentStatus.${d.status}`)}</ToneBadge>
                                </TD>
                                <TD className="min-w-80 space-y-2">
                                    {d.scan.status === 'CLEAN' && <OpenDocumentButton documentId={d.id} />}
                                    {reviewer && d.status === 'PENDING_REVIEW' && <DocumentReviewForm documentId={d.id} />}
                                </TD>
                            </TR>
                        ))}
                    </TBody>
                </Table>
            </Card>
        </>
    );
}
