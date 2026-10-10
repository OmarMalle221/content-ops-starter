import Link from 'next/link';
import { RiskReviewForm } from '@/components/admin/forms';
import { PageHeader } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SEVERITY_ORDER } from '@/domain/risk/engine';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { riskReasonText } from '@/lib/risk-text';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function RiskPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
    const actor = await requireStaff(['compliance_analyst', 'auditor'], '/admin/risk');
    const { t, intl } = await getI18n();
    const { all } = await searchParams;
    const app = await getApp();
    const items = (await app.risk.listAlerts(actor))
        .filter((x) => all === '1' || x.alert.status === 'OPEN' || x.alert.status === 'IN_REVIEW')
        .sort(
            (a, b) =>
                SEVERITY_ORDER[a.alert.severity] - SEVERITY_ORDER[b.alert.severity] || b.alert.createdAt.localeCompare(a.alert.createdAt)
        );
    const canReview = hasRole(actor, 'compliance_analyst');
    return (
        <>
            <PageHeader
                title={t('risk.title')}
                actions={
                    <Link href={all === '1' ? '/admin/risk' : '/admin/risk?all=1'} className="text-sm font-medium text-primary underline">
                        {all === '1' ? t('alertStatus.OPEN') : t('common.all')}
                    </Link>
                }
            />
            <Alert tone="info" className="mb-6">
                {t('risk.disclaimer')}
            </Alert>
            <div className="space-y-4">
                {items.length === 0 && <p className="text-sm text-muted-foreground">{t('risk.none')}</p>}
                {items.map(({ alert: a, reviews, reference }) => (
                    <Card key={a.id}>
                        <CardHeader>
                            <div>
                                <CardTitle>{t(`riskRule.${a.ruleId}`)}</CardTitle>
                                <p className="text-xs text-muted-foreground">
                                    {reference && (
                                        <Link
                                            href={`/admin/transactions/${a.transactionId}?tab=risk`}
                                            className="font-mono text-primary hover:underline"
                                        >
                                            {reference}
                                        </Link>
                                    )}{' '}
                                    · {fmtDate(a.createdAt, intl, true)}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <ToneBadge
                                    tone={
                                        a.severity === 'CRITICAL' || a.severity === 'HIGH'
                                            ? 'danger'
                                            : a.severity === 'MEDIUM'
                                              ? 'warning'
                                              : 'neutral'
                                    }
                                >
                                    {t('risk.priority')} : {t(`severity.${a.severity}`)}
                                </ToneBadge>
                                <ToneBadge tone={toneFor(a.status)}>{t(`alertStatus.${a.status}`)}</ToneBadge>
                                {a.blocksFundsMovement && (
                                    <ToneBadge tone="warning" warning>
                                        {t('risk.blocks')}
                                    </ToneBadge>
                                )}
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <ul className="list-disc space-y-1 pl-5 text-sm">
                                {a.reasons.map((r, i) => (
                                    <li key={i}>{riskReasonText(t, r)}</li>
                                ))}
                            </ul>
                            <p className="text-sm">
                                <span className="font-medium">{t('risk.recommended')} :</span> {t(`riskAction.${a.recommendedAction}`)}
                            </p>
                            {reviews.length > 0 && (
                                <div className="rounded-md bg-muted p-3 text-xs">
                                    <p className="mb-1 font-medium">{t('risk.reviews')}</p>
                                    {reviews.map((r) => (
                                        <p key={r.id}>
                                            {fmtDate(r.createdAt, intl, true)} — {t(`risk.decision.${r.decision}`)} : {r.notes}
                                        </p>
                                    ))}
                                </div>
                            )}
                            {canReview && (a.status === 'OPEN' || a.status === 'IN_REVIEW') && (
                                <RiskReviewForm alertId={a.id} transactionId={a.transactionId} />
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>
        </>
    );
}
