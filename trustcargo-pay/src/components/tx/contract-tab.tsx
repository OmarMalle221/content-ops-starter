import Link from 'next/link';
import { FileSignature, History } from 'lucide-react';
import { Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fromDTO, formatMoney } from '@/domain/money';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtDate, fmtPct } from '@/lib/format';
import { AmendContract, ContractDecision } from './contract-actions';

const FIELDS = [
    'goodsDescription',
    'sellerResponsibilities',
    'buyerResponsibilities',
    'inspectionTerms',
    'shippingTerms',
    'deliveryTerms',
    'releaseTerms',
    'refundTerms',
    'disputeProcedure'
] as const;

export function ContractTab({ view, t, intl }: { view: TransactionView; t: Translator; intl: string }) {
    const c = view.contract;
    if (!c) return null;
    const principals = view.parties.filter((p) => p.role === 'SELLER' || p.role === 'BUYER');
    const changed = new Set(c.changedFields);
    return (
        <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
                <CardHeader>
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <FileSignature className="size-4 text-muted-foreground" aria-hidden />
                            {t('contract.version', { n: c.versionNumber })} — {t('contract.current')}
                        </CardTitle>
                        <CardDescription>{fmtDate(c.createdAt, intl, true)}</CardDescription>
                    </div>
                    <ToneBadge tone={c.status === 'ACCEPTED' ? 'success' : 'info'}>{c.status}</ToneBadge>
                </CardHeader>
                <CardContent className="space-y-5">
                    {c.changeSummary && (
                        <Alert tone="info" title={t('contract.changed')}>
                            <p>{c.changeSummary}</p>
                            <p className="mt-1 text-xs">{c.changedFields.map((f) => t(`contract.fields.${f}`)).join(' · ')}</p>
                        </Alert>
                    )}
                    <dl className="space-y-4">
                        <div className={changed.has('totalAmount') ? 'rounded-md bg-warning-soft/60 p-2' : ''}>
                            <dt className="text-xs text-muted-foreground">{t('contract.fields.totalAmount')}</dt>
                            <dd className="text-lg font-semibold tabular">{formatMoney(fromDTO(c.terms.totalAmount), intl)}</dd>
                        </div>
                        {FIELDS.map((f) => (
                            <div key={f} className={changed.has(f) ? 'rounded-md bg-warning-soft/60 p-2' : ''}>
                                <dt className="text-xs text-muted-foreground">{t(`contract.fields.${f}`)}</dt>
                                <dd className="mt-0.5 text-sm whitespace-pre-line">{c.terms[f]}</dd>
                            </div>
                        ))}
                        <div className={changed.has('deadlines') ? 'rounded-md bg-warning-soft/60 p-2' : ''}>
                            <dt className="text-xs text-muted-foreground">{t('contract.fields.deadlines')}</dt>
                            <dd className="mt-0.5 flex flex-wrap gap-2 text-sm">
                                {(Object.keys(c.terms.deadlines) as (keyof typeof c.terms.deadlines)[]).map((k) => (
                                    <span key={k} className="rounded border bg-muted px-2 py-0.5 text-xs">
                                        {t(`contract.deadlines.${k}`, { n: c.terms.deadlines[k] })}
                                    </span>
                                ))}
                            </dd>
                        </div>
                        <div className={changed.has('milestones') ? 'rounded-md bg-warning-soft/60 p-2' : ''}>
                            <dt className="mb-1 text-xs text-muted-foreground">{t('contract.fields.milestones')}</dt>
                            <dd>
                                <ol className="space-y-2">
                                    {c.terms.milestones.map((m, i) => (
                                        <li key={m.key} className="rounded-md border px-3 py-2 text-sm">
                                            <span className="font-medium">
                                                {i + 1}. {m.title}
                                            </span>{' '}
                                            <span className="text-muted-foreground">— {fmtPct(m.shareBps, intl)}</span>
                                            <p className="text-xs text-muted-foreground">{m.description}</p>
                                            <p className="mt-1 text-xs">
                                                {t('milestone.evidence')} :{' '}
                                                {m.requiredEvidence.map((e) => t(`documentType.${e}`)).join(', ') || '—'}
                                            </p>
                                        </li>
                                    ))}
                                </ol>
                            </dd>
                        </div>
                    </dl>
                    <p className="text-xs text-muted-foreground italic">{t('wizard.milestonesHelp')}</p>
                </CardContent>
            </Card>

            <div className="space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('contract.acceptances')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <ul className="space-y-2">
                            {principals.map((p) => {
                                const a = c.acceptances.find((x) => x.partyId === p.id);
                                return (
                                    <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                                        <span>
                                            {t(`partyRole.${p.role}`)} <span className="text-muted-foreground">· {p.displayName}</span>
                                        </span>
                                        {a ? (
                                            <ToneBadge tone={toneFor(a.decision)}>
                                                {a.decision === 'ACCEPTED' ? '✓' : '✗'} {fmtDate(a.decidedAt, intl)}
                                            </ToneBadge>
                                        ) : (
                                            <ToneBadge tone="neutral">{t('contract.pending')}</ToneBadge>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        {view.can.decideContract &&
                            (view.viewer.kycStatus === 'VERIFIED' ? (
                                <ContractDecision
                                    transactionId={view.id}
                                    versionId={c.currentVersionId}
                                    contentHash={c.contentHash}
                                    versionNumber={c.versionNumber}
                                />
                            ) : (
                                <Alert tone="warning" title={t('contract.kycRequired')}>
                                    <Link href="/verification" className="font-medium underline">
                                        {t('dashboard.kycCta')}
                                    </Link>
                                </Alert>
                            ))}
                        {view.can.amendContract && <AmendContract transactionId={view.id} terms={c.terms} />}
                        <div className="space-y-1 border-t pt-3">
                            <p className="text-xs font-medium">{t('contract.hash')}</p>
                            <Mono>{c.contentHash}</Mono>
                            <p className="text-xs text-muted-foreground">{t('contract.hashHint')}</p>
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <History className="size-4 text-muted-foreground" aria-hidden /> {t('contract.history')}
                        </CardTitle>
                    </CardHeader>
                    <Table>
                        <THead>
                            <tr>
                                <TH>#</TH>
                                <TH>{t('common.date')}</TH>
                                <TH>{t('common.status')}</TH>
                            </tr>
                        </THead>
                        <TBody>
                            {c.history.map((h) => (
                                <TR key={h.id}>
                                    <TD>v{h.versionNumber}</TD>
                                    <TD className="text-xs">{fmtDate(h.createdAt, intl)}</TD>
                                    <TD>
                                        <ToneBadge
                                            tone={h.status === 'SUPERSEDED' ? 'neutral' : h.status === 'ACCEPTED' ? 'success' : 'info'}
                                        >
                                            {h.status}
                                        </ToneBadge>
                                    </TD>
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                </Card>
            </div>
        </div>
    );
}
