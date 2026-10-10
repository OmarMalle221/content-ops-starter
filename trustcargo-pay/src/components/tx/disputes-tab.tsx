import { Gavel } from 'lucide-react';
import { EmptyState } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney, fromDTO } from '@/domain/money';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { DisputeReply, OpenDispute, WithdrawDispute } from './dispute-actions';

export function DisputesTab({
    view,
    t,
    intl,
    staffPanel
}: {
    view: TransactionView;
    t: Translator;
    intl: string;
    staffPanel?: (disputeId: string) => React.ReactNode;
}) {
    const isParty = view.viewer.partyRole === 'SELLER' || view.viewer.partyRole === 'BUYER';
    return (
        <div className="space-y-6">
            <Alert tone="info">{t('dispute.legalNote')}</Alert>
            {view.can.openDispute && (
                <OpenDispute
                    transactionId={view.id}
                    milestones={view.milestones.filter((m) => m.status !== 'RELEASED').map((m) => ({ id: m.id, title: m.title }))}
                />
            )}
            {view.disputes.length === 0 && <EmptyState icon={Gavel} title={t('dispute.none')} />}
            {view.disputes.map((d) => {
                const open = ['AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(d.status);
                return (
                    <Card key={d.id}>
                        <CardHeader>
                            <div>
                                <CardTitle>{t(`disputeReason.${d.reason}`)}</CardTitle>
                                <p className="text-xs text-muted-foreground">
                                    {t(`partyRole.${d.openedByRole}`)} · {fmtDate(d.createdAt, intl, true)} ·{' '}
                                    {t('dispute.responseDue', { date: fmtDate(d.responseDueAt, intl) })}
                                </p>
                            </div>
                            <ToneBadge tone={toneFor(d.status)}>{t(`disputeStatus.${d.status}`)}</ToneBadge>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm">
                                <span className="font-medium">{t('dispute.requestedOutcome')} :</span> {d.requestedOutcome}
                            </p>
                            <ol className="space-y-3" aria-label="Messages">
                                {d.messages.map((m) => (
                                    <li
                                        key={m.id}
                                        className={cn(
                                            'max-w-[90%] rounded-lg border px-3 py-2 text-sm',
                                            m.mine ? 'ml-auto bg-primary-soft' : m.authorRole === 'PLATFORM' ? 'bg-info-soft' : 'bg-muted'
                                        )}
                                    >
                                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                                            {m.authorRole === 'PLATFORM' ? t('dispute.platform') : t(`partyRole.${m.authorRole}`)} ·{' '}
                                            {fmtDate(m.createdAt, intl, true)}
                                        </p>
                                        <p className="whitespace-pre-line">{m.body}</p>
                                    </li>
                                ))}
                            </ol>
                            {d.decision && (
                                <Alert tone="info" title={`${t('dispute.decision')} : ${t(`disputeOutcome.${d.decision.outcome}`)}`}>
                                    <p>{d.decision.rationale}</p>
                                    <p className="mt-1 text-xs">
                                        {t('dispute.clause')} : {d.decision.contractClause} · {t('partyRole.SELLER')} :{' '}
                                        {formatMoney(fromDTO(d.decision.sellerAmount), intl)} · {t('partyRole.BUYER')} :{' '}
                                        {formatMoney(fromDTO(d.decision.buyerRefundAmount), intl)}
                                    </p>
                                </Alert>
                            )}
                            {open && isParty && <DisputeReply transactionId={view.id} disputeId={d.id} />}
                            {open && d.openedByMe && <WithdrawDispute transactionId={view.id} disputeId={d.id} />}
                            {staffPanel?.(d.id)}
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}
