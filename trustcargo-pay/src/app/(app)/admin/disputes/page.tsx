import Link from 'next/link';
import { PageHeader } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function DisputesAdmin() {
    const actor = await requireStaff(['dispute_manager', 'auditor', 'compliance_analyst'], '/admin/disputes');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.disputes.listAll(actor);
    return (
        <>
            <PageHeader title={t('nav.disputes')} />
            <Alert tone="info" className="mb-6">
                {t('dispute.legalNote')} {t('dispute.decideHelp')}
            </Alert>
            <Card>
                <Table>
                    <THead>
                        <tr>
                            <TH>{t('common.reference')}</TH>
                            <TH>{t('dispute.reason')}</TH>
                            <TH>Ouvert par</TH>
                            <TH>{t('common.status')}</TH>
                            <TH>{t('common.date')}</TH>
                        </tr>
                    </THead>
                    <TBody>
                        {list.map(({ dispute: d, reference }) => (
                            <TR key={d.id}>
                                <TD>
                                    <Link
                                        href={`/admin/transactions/${d.transactionId}?tab=disputes`}
                                        className="font-mono text-xs text-primary hover:underline"
                                    >
                                        {reference}
                                    </Link>
                                </TD>
                                <TD>{t(`disputeReason.${d.reason}`)}</TD>
                                <TD>{t(`partyRole.${d.openedByRole}`)}</TD>
                                <TD>
                                    <ToneBadge tone={toneFor(d.status)}>{t(`disputeStatus.${d.status}`)}</ToneBadge>
                                </TD>
                                <TD className="text-xs">{fmtDate(d.createdAt, intl, true)}</TD>
                            </TR>
                        ))}
                    </TBody>
                </Table>
            </Card>
        </>
    );
}
