import Link from 'next/link';
import { PageHeader, Mono } from '@/components/app/layout-bits';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtDate, shortHash } from '@/lib/format';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function AuditPage() {
    const actor = await requireStaff(['auditor', 'compliance_analyst'], '/admin/audit');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const { events, chain } = await app.admin.auditLog(actor);
    return (
        <>
            <PageHeader title={t('audit.title')} />
            <Alert
                tone={chain.valid ? 'success' : 'danger'}
                className="mb-6"
                title={chain.valid ? t('audit.chainValid', { n: chain.length }) : t('audit.chainBroken', { n: chain.brokenAt ?? '?' })}
            />
            <Card>
                <Table>
                    <THead>
                        <tr>
                            <TH>#</TH>
                            <TH>{t('common.date')}</TH>
                            <TH>{t('audit.actor')}</TH>
                            <TH>{t('audit.action')}</TH>
                            <TH>{t('audit.entity')}</TH>
                            <TH>Hash</TH>
                        </tr>
                    </THead>
                    <TBody>
                        {events.slice(0, 300).map((e) => (
                            <TR key={e.id}>
                                <TD className="tabular text-xs">{e.sequence}</TD>
                                <TD className="text-xs whitespace-nowrap">{fmtDate(e.at, intl, true)}</TD>
                                <TD className="text-xs">
                                    {e.actorType}
                                    {e.actorId && e.actorType === 'USER' ? (
                                        <Mono className="block text-[10px] text-muted-foreground">{e.actorId.slice(0, 8)}</Mono>
                                    ) : null}
                                </TD>
                                <TD>
                                    <Mono>{e.action}</Mono>
                                </TD>
                                <TD className="text-xs">
                                    {e.transactionId ? (
                                        <Link
                                            href={`/admin/transactions/${e.transactionId}?tab=history`}
                                            className="text-primary hover:underline"
                                        >
                                            {e.entityType}
                                        </Link>
                                    ) : (
                                        e.entityType
                                    )}
                                </TD>
                                <TD>
                                    <Mono className="text-[10px]">{shortHash(e.hash)}</Mono>
                                </TD>
                            </TR>
                        ))}
                    </TBody>
                </Table>
            </Card>
        </>
    );
}
