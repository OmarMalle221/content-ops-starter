import Link from 'next/link';
import { PageHeader } from '@/components/app/layout-bits';
import { TransactionStatusBadge } from '@/components/app/status';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatMoney } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';
import { TX_READERS } from '@/server/staff';

export default async function AdminTransactions() {
    const actor = await requireStaff(TX_READERS, '/admin/transactions');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.admin.listTransactions(actor);
    return (
        <>
            <PageHeader title={t('nav.transactions')} />
            <Card>
                <Table>
                    <THead>
                        <tr>
                            <TH>{t('common.reference')}</TH>
                            <TH>{t('tx.vehicle')}</TH>
                            <TH className="text-right">{t('common.amount')}</TH>
                            <TH>{t('common.status')}</TH>
                            <TH>{t('tx.updated')}</TH>
                        </tr>
                    </THead>
                    <TBody>
                        {list.map((tx) => (
                            <TR key={tx.id}>
                                <TD className="font-mono text-xs">
                                    <Link className="text-primary hover:underline" href={`/admin/transactions/${tx.id}`}>
                                        {tx.reference}
                                    </Link>
                                </TD>
                                <TD>{tx.title}</TD>
                                <TD className="text-right tabular">{formatMoney(tx.amount, intl)}</TD>
                                <TD>
                                    <TransactionStatusBadge status={tx.status} label={t(`status.${tx.status}`)} />
                                </TD>
                                <TD className="text-xs text-muted-foreground">{fmtDate(tx.updatedAt, intl, true)}</TD>
                            </TR>
                        ))}
                    </TBody>
                </Table>
            </Card>
        </>
    );
}
