import { PageHeader, KeyValue } from '@/components/app/layout-bits';
import { SimulateKyc, StartKyc } from '@/components/app/kyc-actions';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export const metadata = { title: 'Vérification d’identité' };

export default async function VerificationPage() {
    const actor = await requireActor();
    const { t, intl } = await getI18n();
    const app = await getApp();
    const { user, verifications } = await app.deps.uow.run(async (db) => ({
        user: (await db.users.get(actor.userId))!,
        verifications: (await db.identityVerifications.findBy({ subjectType: 'USER', subjectId: actor.userId })).sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt)
        )
    }));
    const pending = verifications.find((v) => v.status === 'PENDING' && v.checks.length === 0);
    return (
        <>
            <PageHeader title={t('verification.title')} description={t('verification.subtitle')} />
            <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                    <CardHeader>
                        <CardTitle>{t('verification.statusLabel')}</CardTitle>
                        <ToneBadge tone={toneFor(user.kycStatus)}>{t(`kyc.${user.kycStatus}`)}</ToneBadge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">{t('verification.providerNote')}</p>
                        {(user.kycStatus === 'NOT_STARTED' || user.kycStatus === 'REJECTED' || user.kycStatus === 'EXPIRED') && (
                            <StartKyc />
                        )}
                        {pending && (
                            <Alert tone="warning" title={t('verification.simulated')}>
                                <div className="mt-2">
                                    <SimulateKyc verificationId={pending.id} />
                                </div>
                            </Alert>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('verification.history')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {verifications.length === 0 && <p className="text-sm text-muted-foreground">{t('common.none')}</p>}
                        {verifications.map((v) => (
                            <div key={v.id} className="space-y-2 rounded-md border p-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">{fmtDate(v.createdAt, intl, true)}</span>
                                    <ToneBadge tone={toneFor(v.status)}>{t(`kyc.${v.status}`)}</ToneBadge>
                                </div>
                                <KeyValue
                                    className="sm:grid-cols-1"
                                    items={[
                                        { label: 'Prestataire', value: `${v.provider}${v.simulated ? ` (${t('common.simulated')})` : ''}` },
                                        ...(v.verifiedName ? [{ label: t('verification.verifiedName'), value: v.verifiedName }] : []),
                                        ...(v.documentType
                                            ? [
                                                  {
                                                      label: t('verification.document'),
                                                      value: `${v.documentType} · ${v.documentCountry} · ${t('verification.expiresOn')} ${v.documentExpiresAt}`
                                                  }
                                              ]
                                            : []),
                                        ...(v.checks.length
                                            ? [
                                                  {
                                                      label: t('verification.checks'),
                                                      value: v.checks.map((c) => `${c.code}: ${c.result}`).join(' · ')
                                                  }
                                              ]
                                            : [])
                                    ]}
                                />
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
        </>
    );
}
