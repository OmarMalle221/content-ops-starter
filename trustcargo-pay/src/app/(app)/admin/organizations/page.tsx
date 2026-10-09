import { PageHeader, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtPct } from '@/lib/format';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function Organizations() {
    const actor = await requireStaff(['compliance_analyst', 'auditor'], '/admin/organizations');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.admin.listOrganizations(actor);
    return (
        <>
            <PageHeader title={t('nav.organizations')} />
            <Card>
                <Table>
                    <THead>
                        <tr>
                            <TH>Raison sociale</TH>
                            <TH>Type</TH>
                            <TH>N°</TH>
                            <TH>{t('settings.beneficialOwners')}</TH>
                            <TH>KYB</TH>
                        </tr>
                    </THead>
                    <TBody>
                        {list.map(({ organization: o, owners }) => (
                            <TR key={o.id}>
                                <TD>
                                    <p className="font-medium">{o.legalName}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {o.city} ({o.country})
                                    </p>
                                </TD>
                                <TD className="text-xs">{o.type}</TD>
                                <TD>
                                    <Mono>{o.registrationNumber}</Mono>
                                </TD>
                                <TD className="text-xs">
                                    {owners.map((b) => `${b.fullName} (${fmtPct(b.ownershipBps, intl)})`).join(', ')}
                                </TD>
                                <TD>
                                    <ToneBadge tone={toneFor(o.kybStatus)}>{t(`kyc.${o.kybStatus}`)}</ToneBadge>
                                </TD>
                            </TR>
                        ))}
                    </TBody>
                </Table>
            </Card>
        </>
    );
}
