import Link from 'next/link';
import { ArrowRight, Car, Landmark, Users } from 'lucide-react';
import { KeyValue, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fromDTO, money, formatMoney } from '@/domain/money';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { nextActionFor } from '@/lib/next-action';
import { RegenerateInvitation, SendInvitations } from './invitation-actions';

export function OverviewTab({ view, t, intl, basePath }: { view: TransactionView; t: Translator; intl: string; basePath: string }) {
    const next = nextActionFor(view);
    const v = view.vehicle;
    return (
        <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
                <Card className={next.mine ? 'border-primary/40 ring-1 ring-primary/20' : ''}>
                    <CardHeader>
                        <CardTitle>{t('tx.nextStep')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">{t(`statusHelp.${view.status}`)}</p>
                        {view.can.sendInvitations ? (
                            <SendInvitations transactionId={view.id} />
                        ) : (
                            <Link
                                href={`${basePath}?tab=${next.tab}`}
                                className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
                                data-testid="next-action"
                            >
                                {t(`nextAction.${next.key}`)} <ArrowRight className="size-4" aria-hidden />
                            </Link>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Users className="size-4 text-muted-foreground" aria-hidden /> {t('tx.parties')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="divide-y p-0">
                        {view.parties.map((p) => (
                            <div key={p.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium">
                                        {p.displayName}{' '}
                                        {p.isMe && <span className="text-xs text-muted-foreground">({t('common.you')})</span>}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {t(`partyRole.${p.role}`)} · {p.email}
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <ToneBadge tone={toneFor(p.status)}>{t(`partyStatus.${p.status}`)}</ToneBadge>
                                    {p.kycStatus && <ToneBadge tone={toneFor(p.kycStatus)}>KYC : {t(`kyc.${p.kycStatus}`)}</ToneBadge>}
                                    {p.status === 'INVITED' && view.can.regenerateInvitation && (
                                        <RegenerateInvitation transactionId={view.id} partyId={p.id} />
                                    )}
                                </div>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>

            <div className="space-y-6">
                {v && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Car className="size-4 text-muted-foreground" aria-hidden /> {t('tx.vehicle')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <KeyValue
                                className="sm:grid-cols-1"
                                items={[
                                    {
                                        label: t('tx.vehicle'),
                                        value: `${v.make} ${v.model} ${v.year}${v.exteriorColor ? ` · ${v.exteriorColor}` : ''}`
                                    },
                                    {
                                        label: t('tx.vin'),
                                        value: (
                                            <span className="flex flex-col gap-1">
                                                <Mono className="text-sm">{v.vin}</Mono>
                                                <span title={t('tx.vinOkHint')}>
                                                    <ToneBadge tone={v.vinStructurallyValid ? 'success' : 'danger'}>
                                                        {v.vinStructurallyValid ? t('tx.vinOk') : t('tx.vinBad')}
                                                    </ToneBadge>
                                                </span>
                                                <span className="text-xs font-normal text-muted-foreground">{t('tx.vinOkHint')}</span>
                                            </span>
                                        )
                                    },
                                    { label: t('tx.mileage'), value: `${new Intl.NumberFormat(intl).format(v.mileageKm)} km` },
                                    {
                                        label: t('tx.condition'),
                                        value: t(`condition.${v.declaredCondition}`) + (v.conditionNotes ? ` — ${v.conditionNotes}` : '')
                                    },
                                    { label: t('tx.route'), value: `${v.originCountry} → ${v.destinationCountry} (${view.corridorCode})` }
                                ]}
                            />
                        </CardContent>
                    </Card>
                )}
                {view.payment && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Landmark className="size-4 text-muted-foreground" aria-hidden /> {t('tx.fundsHeld')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <p className="text-2xl font-semibold tabular" data-testid="funds-held">
                                {formatMoney(money(BigInt(view.payment.heldMinor), fromDTO(view.amount).currency), intl)}
                            </p>
                            <p className="text-xs text-muted-foreground">{t('tx.fundsHeldHint')}</p>
                            {view.payment.providerSimulated && <ToneBadge tone="warning">{t('common.simulated')}</ToneBadge>}
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
