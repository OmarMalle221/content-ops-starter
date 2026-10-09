import Link from 'next/link';
import { PageHeader, Stat } from '@/components/app/layout-bits';
import { TransactionStatusBadge } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { TransactionStatus } from '@/domain/model';
import { getI18n } from '@/i18n/server';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';
import { ALL_STAFF } from '@/server/staff';

export const metadata = { title: 'Back-office' };

export default async function AdminHome() {
    const actor = await requireStaff(ALL_STAFF, '/admin');
    const { t } = await getI18n();
    const app = await getApp();
    const o = await app.admin.overview(actor);
    const kpis = [
        ['transactions', o.transactions, '/admin/transactions'],
        ['openAlerts', o.openAlerts, '/admin/risk'],
        ['pendingKyc', o.pendingKyc, '/admin/verifications'],
        ['documentsToReview', o.documentsToReview, '/admin/documents'],
        ['openDisputes', o.openDisputes, '/admin/disputes'],
        ['failedProviderEvents', o.failedProviderEvents, '/admin/partners'],
        ['activeHolds', o.activeHolds, '/admin/risk']
    ] as const;
    return (
        <>
            <PageHeader title={t('admin.title')} description={t('admin.leastPrivilege', { roles: actor.platformRoles.join(', ') })} />
            <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
                {kpis.map(([k, v, href]) => (
                    <Link key={k} href={href} className="rounded-lg focus-visible:outline-2">
                        <Stat label={t(`admin.kpi.${k}`)} value={v} />
                    </Link>
                ))}
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('nav.transactions')}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                        {Object.entries(o.byStatus).map(([s, n]) => (
                            <span key={s} className="inline-flex items-center gap-1.5">
                                <TransactionStatusBadge status={s as TransactionStatus} label={`${t(`status.${s}`)} · ${n}`} />
                            </span>
                        ))}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.trialBalance')}</CardTitle>
                    </CardHeader>
                    <Table>
                        <THead>
                            <tr>
                                <TH>Devise</TH>
                                <TH className="text-right">Débits</TH>
                                <TH className="text-right">Crédits</TH>
                                <TH />
                            </tr>
                        </THead>
                        <TBody>
                            {o.trialBalance.map((r) => (
                                <TR key={r.currency}>
                                    <TD>{r.currency}</TD>
                                    <TD className="text-right font-mono text-xs">{r.debits}</TD>
                                    <TD className="text-right font-mono text-xs">{r.credits}</TD>
                                    <TD className={r.balanced ? 'text-success' : 'font-semibold text-danger'}>
                                        {r.balanced ? t('admin.balanced') : t('admin.unbalanced')}
                                    </TD>
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                    <CardContent>
                        <Alert tone="info">{t('tx.fundsHeldHint')}</Alert>
                    </CardContent>
                </Card>
            </div>
        </>
    );
}
