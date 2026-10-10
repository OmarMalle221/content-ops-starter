import { FlaskConical, Landmark } from 'lucide-react';
import { EmptyState, KeyValue, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatMoney, fromDTO, money } from '@/domain/money';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtDate } from '@/lib/format';
import { PartnerSimulator, RequestFunding } from './payment-actions';

export function PaymentsTab({ view, t, intl }: { view: TransactionView; t: Translator; intl: string }) {
    const p = view.payment;
    if (!p) return null;
    const currency = fromDTO(view.amount).currency;
    const i = p.instruction;
    return (
        <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
                {p.providerSimulated && (
                    <Alert tone="warning" title={t('payment.simulationNotice')}>
                        {t('payment.partnerOnly')}
                    </Alert>
                )}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Landmark className="size-4 text-muted-foreground" aria-hidden /> {t('payment.instructions')}
                        </CardTitle>
                        {i && <ToneBadge tone={toneFor(i.status)}>{t(`instructionStatus.${i.status}`)}</ToneBadge>}
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {i ? (
                            <>
                                <KeyValue
                                    items={[
                                        {
                                            label: t('common.amount'),
                                            value: <span className="text-base tabular">{formatMoney(fromDTO(i.amount), intl)}</span>
                                        },
                                        {
                                            label: t('payment.paymentReference'),
                                            value: <Mono className="text-sm">{i.details.paymentReference}</Mono>
                                        },
                                        { label: t('payment.beneficiary'), value: i.details.beneficiaryName },
                                        { label: t('payment.bank'), value: i.details.bankName },
                                        { label: t('payment.account'), value: <Mono className="text-sm">{i.details.accountMasked}</Mono> },
                                        { label: t('payment.expires'), value: fmtDate(i.expiresAt, intl) }
                                    ]}
                                />
                                <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{i.details.notes}</p>
                            </>
                        ) : (
                            <p className="text-sm text-muted-foreground">{t('statusHelp.AWAITING_FUNDING')}</p>
                        )}
                        {view.can.requestFunding && (!i || i.status === 'FAILED' || i.status === 'CANCELLED') && (
                            <RequestFunding transactionId={view.id} />
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('payment.payouts')}</CardTitle>
                    </CardHeader>
                    {p.payouts.length === 0 ? (
                        <CardContent>
                            <EmptyState title={t('payment.noPayouts')} />
                        </CardContent>
                    ) : (
                        <Table>
                            <THead>
                                <tr>
                                    <TH>{t('common.date')}</TH>
                                    <TH>{t('tx.tabs.milestones')}</TH>
                                    <TH className="text-right">{t('common.amount')}</TH>
                                    <TH>{t('common.status')}</TH>
                                    <TH>{t('payment.attempts')}</TH>
                                </tr>
                            </THead>
                            <TBody>
                                {p.payouts.map((po) => (
                                    <TR key={po.id}>
                                        <TD className="text-xs whitespace-nowrap">{fmtDate(po.requestedAt, intl, true)}</TD>
                                        <TD>{po.milestoneTitle ?? t('dispute.decision')}</TD>
                                        <TD className="text-right tabular">{formatMoney(fromDTO(po.amount), intl)}</TD>
                                        <TD>
                                            <ToneBadge tone={toneFor(po.status)}>{t(`payoutStatus.${po.status}`)}</ToneBadge>
                                            {po.failureReason && <p className="mt-1 text-xs text-danger">{po.failureReason}</p>}
                                        </TD>
                                        <TD className="tabular">{po.attempts}</TD>
                                    </TR>
                                ))}
                            </TBody>
                        </Table>
                    )}
                </Card>
                {p.refunds.length > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('payment.refunds')}</CardTitle>
                        </CardHeader>
                        <Table>
                            <TBody>
                                {p.refunds.map((r) => (
                                    <TR key={r.id}>
                                        <TD className="text-xs">{fmtDate(r.requestedAt, intl, true)}</TD>
                                        <TD className="text-right tabular">{formatMoney(fromDTO(r.amount), intl)}</TD>
                                        <TD>
                                            <ToneBadge tone={toneFor(r.status)}>{t(`payoutStatus.${r.status}`)}</ToneBadge>
                                        </TD>
                                    </TR>
                                ))}
                            </TBody>
                        </Table>
                    </Card>
                )}
            </div>
            <div className="space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('tx.fundsHeld')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <p className="text-2xl font-semibold tabular">{formatMoney(money(BigInt(p.heldMinor), currency), intl)}</p>
                        <p className="text-xs text-muted-foreground">{t('tx.fundsHeldHint')}</p>
                    </CardContent>
                </Card>
                {view.can.simulatePartner && view.simulator && (
                    <Card className="border-dashed border-warning/50 bg-warning-soft/30">
                        <CardHeader className="block">
                            <CardTitle className="flex items-center gap-2">
                                <FlaskConical className="size-4 text-warning" aria-hidden /> {t('payment.simulator')}
                            </CardTitle>
                            <CardDescription>{t('payment.simulatorHelp')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <PartnerSimulator
                                transactionId={view.id}
                                instructionReference={view.simulator.instructionReference}
                                transfers={view.simulator.transfers}
                            />
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
