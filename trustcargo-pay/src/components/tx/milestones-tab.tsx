import { CheckCircle2, CircleAlert, Flag } from 'lucide-react';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney, fromDTO } from '@/domain/money';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtDate, fmtPct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AttachEvidence, ReviewMilestone, SubmitMilestone } from './milestone-actions';
import { UploadDocumentForm } from './upload-form';

export function MilestonesTab({ view, t, intl }: { view: TransactionView; t: Translator; intl: string }) {
    const role = view.viewer.partyRole;
    const canAddEvidence = role === 'SELLER' || role === 'INSPECTOR' || role === 'FREIGHT_FORWARDER';
    return (
        <div className="space-y-4">
            {view.milestones.map((m) => {
                const open = m.status === 'ACTIVE' || m.status === 'CHANGES_REQUESTED';
                const attachable = view.documents.filter(
                    (d) =>
                        d.isMine &&
                        !m.evidence.some((e) => e.documentId === d.id) &&
                        !['SUPERSEDED', 'REJECTED', 'QUARANTINED'].includes(d.status)
                );
                return (
                    <Card
                        key={m.id}
                        className={cn(open && 'border-primary/40', m.status === 'SUBMITTED' && 'border-warning/50')}
                        data-testid={`milestone-${m.sequence}`}
                    >
                        <CardHeader>
                            <div className="min-w-0">
                                <CardTitle className="flex items-center gap-2">
                                    <Flag className="size-4 text-muted-foreground" aria-hidden />
                                    {m.sequence}. {m.title}
                                </CardTitle>
                                <p className="text-xs text-muted-foreground">
                                    {formatMoney(fromDTO(m.amount), intl)} · {t('milestone.share', { pct: fmtPct(m.shareBps, intl) })}
                                </p>
                            </div>
                            <ToneBadge tone={m.status === 'PENDING' ? 'neutral' : toneFor(m.status)}>
                                {t(`milestoneStatus.${m.status}`)}
                            </ToneBadge>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-muted-foreground">{m.description}</p>
                            <div>
                                <p className="mb-2 text-xs font-medium text-muted-foreground uppercase">{t('milestone.evidence')}</p>
                                <ul className="grid gap-2 sm:grid-cols-2">
                                    {m.requiredEvidence.map((type) => {
                                        const missing = m.missingEvidence.includes(type);
                                        const docs = m.evidence.filter((e) => e.type === type);
                                        return (
                                            <li key={type} className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
                                                {missing ? (
                                                    <CircleAlert className="mt-0.5 size-4 text-warning" aria-hidden />
                                                ) : (
                                                    <CheckCircle2 className="mt-0.5 size-4 text-success" aria-hidden />
                                                )}
                                                <span className="min-w-0">
                                                    <span className="block font-medium">{t(`documentType.${type}`)}</span>
                                                    <span className="block truncate text-xs text-muted-foreground">
                                                        {missing
                                                            ? t('milestone.missing')
                                                            : docs
                                                                  .map((d) => `${d.title} (${t(`documentStatus.${d.status}`)})`)
                                                                  .join(', ') || t('milestone.provided')}
                                                    </span>
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                            {m.submissionNote && (
                                <p className="rounded-md bg-muted px-3 py-2 text-sm">
                                    <span className="font-medium">{t('milestone.submittedNote')} :</span> {m.submissionNote}{' '}
                                    <span className="text-xs text-muted-foreground">({fmtDate(m.submittedAt, intl, true)})</span>
                                </p>
                            )}
                            {m.status === 'CHANGES_REQUESTED' && m.changeRequestReason && (
                                <Alert tone="warning" title={t('milestone.changesRequested')}>
                                    {m.changeRequestReason}
                                </Alert>
                            )}
                            {m.payout && (
                                <p className="text-sm">
                                    {t('milestone.payout')} :{' '}
                                    <ToneBadge tone={toneFor(m.payout.status)}>{t(`payoutStatus.${m.payout.status}`)}</ToneBadge>
                                    {m.payout.failureReason && <span className="ml-2 text-xs text-danger">{m.payout.failureReason}</span>}
                                </p>
                            )}
                            {m.status === 'APPROVED' && !m.payout && view.blockedReasons.length > 0 && (
                                <Alert tone="warning">
                                    {t('milestone.blocked', { reasons: view.blockedReasons.map((b) => t(`blocker.${b}`)).join(' ') })}
                                </Alert>
                            )}

                            {open && canAddEvidence && view.can.uploadDocuments && (
                                <div className="space-y-4 rounded-lg border border-dashed p-4">
                                    <UploadDocumentForm
                                        transactionId={view.id}
                                        types={view.can.uploadableTypes.filter((ty) => m.requiredEvidence.includes(ty) || ty === 'PHOTO')}
                                        milestones={[{ id: m.id, title: m.title }]}
                                        defaultMilestoneId={m.id}
                                        defaultType={m.missingEvidence.find((ty) => view.can.uploadableTypes.includes(ty))}
                                        myDocuments={view.documents
                                            .filter((d) => d.isMine)
                                            .map((d) => ({ id: d.id, type: d.type, title: d.title, version: d.version }))}
                                    />
                                    <AttachEvidence
                                        transactionId={view.id}
                                        milestoneId={m.id}
                                        documents={attachable.map((d) => ({
                                            id: d.id,
                                            label: `${t(`documentType.${d.type}`)} — ${d.title}`
                                        }))}
                                    />
                                </div>
                            )}
                            {open && view.can.submitMilestone && (
                                <SubmitMilestone transactionId={view.id} milestoneId={m.id} disabled={m.missingEvidence.length > 0} />
                            )}
                            {m.status === 'SUBMITTED' && view.can.reviewMilestone && (
                                <ReviewMilestone
                                    transactionId={view.id}
                                    milestoneId={m.id}
                                    amountLabel={formatMoney(fromDTO(m.amount), intl)}
                                />
                            )}
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}
