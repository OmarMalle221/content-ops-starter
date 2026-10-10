import { ResetDemo, SecurityForm } from '@/components/admin/forms';
import { PageHeader, KeyValue } from '@/components/app/layout-bits';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getI18n } from '@/i18n/server';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function SecurityPage() {
    const actor = await requireStaff(['platform_admin', 'auditor'], '/admin/security');
    const { t } = await getI18n();
    const app = await getApp();
    const s = await app.admin.securitySettings(actor);
    const admin = hasRole(actor, 'platform_admin');
    return (
        <>
            <PageHeader title={t('nav.security')} />
            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('nav.security')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <KeyValue
                            items={[
                                { label: t('admin.adminMfa'), value: s.adminMfaMaxAgeMinutes },
                                { label: t('admin.mfaWindow'), value: s.sensitiveActionMfaMaxAgeMinutes },
                                { label: t('admin.cooling'), value: s.payoutAccountCoolingOffHours },
                                { label: t('admin.invitationTtl'), value: s.invitationTtlHours },
                                { label: t('admin.signedUrlTtl'), value: s.signedUrlTtlSeconds },
                                { label: t('admin.maxUpload'), value: s.maxUploadBytes }
                            ]}
                        />
                        {admin && <SecurityForm cooling={s.payoutAccountCoolingOffHours} mfa={s.sensitiveActionMfaMaxAgeMinutes} />}
                    </CardContent>
                </Card>
                {admin && app.config.mode === 'demo' && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.resetDemo')}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ResetDemo />
                        </CardContent>
                    </Card>
                )}
            </div>
        </>
    );
}
