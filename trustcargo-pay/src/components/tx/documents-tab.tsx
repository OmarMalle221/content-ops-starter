import { FileText, ShieldQuestion } from 'lucide-react';
import { EmptyState, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtBytes, fmtDate, shortHash } from '@/lib/format';
import { cn } from '@/lib/cn';
import { OpenDocumentButton } from './document-open';
import { UploadDocumentForm } from './upload-form';

export function DocumentsTab({ view, t, intl }: { view: TransactionView; t: Translator; intl: string }) {
    const openMilestones = view.milestones.filter(
        (m) => m.status === 'ACTIVE' || m.status === 'CHANGES_REQUESTED' || m.status === 'PENDING'
    );
    return (
        <div className="space-y-6">
            {view.can.uploadDocuments && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('documents.upload')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <UploadDocumentForm
                            transactionId={view.id}
                            types={view.can.uploadableTypes}
                            milestones={openMilestones.map((m) => ({ id: m.id, title: m.title }))}
                            myDocuments={view.documents
                                .filter((d) => d.isMine)
                                .map((d) => ({ id: d.id, type: d.type, title: d.title, version: d.version }))}
                        />
                    </CardContent>
                </Card>
            )}
            <Card>
                <CardHeader>
                    <CardTitle>{t('tx.tabs.documents')}</CardTitle>
                    <CardDescription>{t('documents.accessNote')}</CardDescription>
                </CardHeader>
                {view.documents.length === 0 ? (
                    <CardContent>
                        <EmptyState icon={FileText} title={t('documents.empty')} />
                    </CardContent>
                ) : (
                    <Table>
                        <THead>
                            <tr>
                                <TH>{t('documents.title')}</TH>
                                <TH>{t('documents.type')}</TH>
                                <TH>{t('common.status')}</TH>
                                <TH>{t('documents.uploadedBy')}</TH>
                                <TH>{t('documents.sha')}</TH>
                                <TH className="text-right">{t('common.actions')}</TH>
                            </tr>
                        </THead>
                        <TBody>
                            {view.documents.map((d) => (
                                <TR key={d.id} className={cn(d.status === 'SUPERSEDED' && 'opacity-60')}>
                                    <TD>
                                        <p className="font-medium">
                                            {d.title}{' '}
                                            <span className="text-xs text-muted-foreground">
                                                {t('documents.version', { n: d.version })}
                                            </span>
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {d.fileName} · {fmtBytes(d.sizeBytes)} · {fmtDate(d.uploadedAt, intl, true)}
                                        </p>
                                    </TD>
                                    <TD>{t(`documentType.${d.type}`)}</TD>
                                    <TD>
                                        <ToneBadge tone={toneFor(d.status)}>{t(`documentStatus.${d.status}`)}</ToneBadge>
                                    </TD>
                                    <TD className="text-sm">{d.uploadedBy}</TD>
                                    <TD title={d.sha256}>
                                        <Mono>{shortHash(d.sha256)}</Mono>
                                    </TD>
                                    <TD className="text-right">
                                        {d.canOpen ? (
                                            <OpenDocumentButton documentId={d.id} />
                                        ) : (
                                            <span className="text-xs text-muted-foreground">—</span>
                                        )}
                                    </TD>
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                )}
            </Card>
            {view.comparison && view.comparison[0] && view.comparison[0].cells.length > 0 && (
                <Card>
                    <CardHeader className="block">
                        <CardTitle className="flex items-center gap-2">
                            <ShieldQuestion className="size-4 text-muted-foreground" aria-hidden /> {t('documents.comparison')}
                        </CardTitle>
                        <CardDescription>{t('documents.comparisonHint')}</CardDescription>
                    </CardHeader>
                    <Table>
                        <THead>
                            <tr>
                                <TH />
                                <TH>{t('documents.expected')}</TH>
                                {view.comparison[0].cells.map((c) => (
                                    <TH key={c.documentId}>{t(`documentType.${c.documentType}`)}</TH>
                                ))}
                            </tr>
                        </THead>
                        <TBody>
                            {view.comparison.map((row) => (
                                <TR key={row.field}>
                                    <TD className="font-medium whitespace-nowrap">{t(`documents.fields.${row.field}`)}</TD>
                                    <TD className="text-xs">{row.expected ?? '—'}</TD>
                                    {row.cells.map((c) => (
                                        <TD
                                            key={c.documentId}
                                            className={cn(
                                                'text-xs',
                                                c.status === 'MISMATCH' && 'bg-danger-soft font-semibold text-danger',
                                                c.status === 'MATCH' && 'text-success'
                                            )}
                                        >
                                            {c.status === 'NOT_PRESENT'
                                                ? t('documents.absent')
                                                : `${c.value} ${c.status === 'MATCH' ? '✓' : '≠'}`}
                                        </TD>
                                    ))}
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                </Card>
            )}
        </div>
    );
}
