import { KycReviewForm } from '@/components/admin/forms';
import { PageHeader } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function Verifications() {
    const actor = await requireStaff(['compliance_analyst', 'auditor'], '/admin/verifications');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.identity.listPending(actor);
    return (
        <>
            <PageHeader title={t('nav.verifications')} description={t('verification.providerNote')} />
            <Card>
                <Table>
                    <THead>
                        <tr>
                            <TH>Sujet</TH>
                            <TH>Prestataire</TH>
                            <TH>{t('verification.checks')}</TH>
                            <TH>{t('common.status')}</TH>
                            <TH>{t('common.date')}</TH>
                            <TH>{t('common.actions')}</TH>
                        </tr>
                    </THead>
                    <TBody>
                        {list.map(({ verification: v, subjectName }) => (
                            <TR key={v.id}>
                                <TD>
                                    <p className="font-medium">{subjectName}</p>
                                    <p className="text-xs text-muted-foreground">{v.subjectType}</p>
                                </TD>
                                <TD className="text-xs">
                                    {v.provider}
                                    {v.simulated && <ToneBadge tone="warning">{t('common.simulated')}</ToneBadge>}
                                </TD>
                                <TD className="text-xs">{v.checks.map((c) => `${c.code}: ${c.result}`).join(' · ') || '—'}</TD>
                                <TD>
                                    <ToneBadge tone={toneFor(v.status)}>{t(`kyc.${v.status}`)}</ToneBadge>
                                </TD>
                                <TD className="text-xs">{fmtDate(v.createdAt, intl)}</TD>
                                <TD className="min-w-72">
                                    {v.status === 'PENDING' && v.checks.length > 0 && hasRole(actor, 'compliance_analyst') ? (
                                        <KycReviewForm verificationId={v.id} />
                                    ) : null}
                                </TD>
                            </TR>
                        ))}
                    </TBody>
                </Table>
            </Card>
        </>
    );
}
