import { ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SEVERITY_ORDER } from '@/domain/risk/engine';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtDate } from '@/lib/format';
import { riskReasonText } from '@/lib/risk-text';

export function RiskTab({
    view,
    t,
    intl,
    reviewPanel
}: {
    view: TransactionView;
    t: Translator;
    intl: string;
    reviewPanel?: (alertId: string) => React.ReactNode;
}) {
    const alerts = [...(view.risk ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return (
        <div className="space-y-4">
            <Alert tone="info">{t('risk.disclaimer')}</Alert>
            {alerts.length === 0 && <EmptyState icon={ShieldAlert} title={t('risk.none')} />}
            {alerts.map((a) => (
                <Card key={a.id}>
                    <CardHeader>
                        <div>
                            <CardTitle>{t(`riskRule.${a.ruleId}`)}</CardTitle>
                            <p className="text-xs text-muted-foreground">
                                {a.ruleId} · {fmtDate(a.createdAt, intl, true)}
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
                        {a.blocksFundsMovement && (
                            <ToneBadge tone="warning" warning>
                                {t('risk.blocks')}
                            </ToneBadge>
                        )}
                        {reviewPanel && (a.status === 'OPEN' || a.status === 'IN_REVIEW') && reviewPanel(a.id)}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
