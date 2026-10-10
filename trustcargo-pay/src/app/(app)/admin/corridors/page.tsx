import { CorridorForm } from '@/components/admin/forms';
import { PageHeader, KeyValue } from '@/components/app/layout-bits';
import { ToneBadge } from '@/components/app/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney, money, toDecimalString, type CurrencyCode } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function Corridors() {
    const actor = await requireStaff(['platform_admin', 'auditor', 'compliance_analyst'], '/admin/corridors');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const corridors = await app.admin.corridors(actor);
    const admin = hasRole(actor, 'platform_admin');
    return (
        <>
            <PageHeader title={t('nav.corridors')} />
            <div className="space-y-6">
                {corridors.map((c) => {
                    const cur = (c.allowedCurrencies[0] ?? 'CAD') as CurrencyCode;
                    const th = money(BigInt(c.reviewThresholdMinor[cur] ?? '0'), cur);
                    return (
                        <Card key={c.id}>
                            <CardHeader>
                                <CardTitle>
                                    {c.code} · {c.originCountry} → {c.destinationCountry}
                                </CardTitle>
                                <ToneBadge tone={c.enabled ? 'success' : 'neutral'}>
                                    {c.enabled ? t('admin.corridorEnabled') : '—'}
                                </ToneBadge>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <KeyValue
                                    items={[
                                        { label: t('wizard.currency'), value: c.allowedCurrencies.join(', ') },
                                        {
                                            label: t('admin.threshold'),
                                            value: Object.entries(c.reviewThresholdMinor)
                                                .map(([k, v]) => formatMoney(money(BigInt(v!), k as CurrencyCode), intl))
                                                .join(' · ')
                                        },
                                        { label: t('admin.ports'), value: c.expectedDischargePorts.join(', ') },
                                        {
                                            label: t('admin.requiredDocs'),
                                            value: c.requiredDocumentsBeforeFunding.map((d) => t(`documentType.${d}`)).join(', ')
                                        }
                                    ]}
                                />
                                {admin && (
                                    <CorridorForm corridorId={c.id} enabled={c.enabled} threshold={toDecimalString(th)} currency={cur} />
                                )}
                            </CardContent>
                        </Card>
                    );
                })}
            </div>
        </>
    );
}
