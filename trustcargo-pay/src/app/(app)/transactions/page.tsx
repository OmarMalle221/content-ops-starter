import Link from 'next/link';
import { Inbox, Plus } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/app/layout-bits';
import { TransactionStatusBadge } from '@/components/app/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatMoney } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export const metadata = { title: 'Transactions' };

export default async function TransactionsPage() {
    const actor = await requireActor();
    const { t, intl } = await getI18n();
    const app = await getApp();
    const list = await app.transactions.listForActor(actor);
    return (
        <>
            <PageHeader
                title={t('tx.list')}
                actions={
                    <Button asChild>
                        <Link href="/transactions/new">
                            <Plus aria-hidden /> {t('nav.newTransaction')}
                        </Link>
                    </Button>
                }
            />
            {list.length === 0 ? (
                <EmptyState icon={Inbox} title={t('tx.listEmpty')}>
                    <Link href="/transactions/new" className="font-medium text-primary underline">
                        {t('tx.listEmptyCta')}
                    </Link>
                </EmptyState>
            ) : (
                <Card>
                    <Table>
                        <THead>
                            <tr>
                                <TH>{t('common.reference')}</TH>
                                <TH>{t('tx.vehicle')}</TH>
                                <TH>{t('tx.myRole')}</TH>
                                <TH>{t('tx.counterparty')}</TH>
                                <TH className="text-right">{t('common.amount')}</TH>
                                <TH>{t('common.status')}</TH>
                                <TH>{t('tx.updated')}</TH>
                            </tr>
                        </THead>
                        <TBody>
                            {list.map(({ transaction: tx, myRole, counterpartyName }) => (
                                <TR key={tx.id}>
                                    <TD className="font-mono text-xs">
                                        <Link href={`/transactions/${tx.id}`} className="text-primary hover:underline">
                                            {tx.reference}
                                        </Link>
                                    </TD>
                                    <TD className="font-medium">
                                        <Link href={`/transactions/${tx.id}`} className="hover:underline">
                                            {tx.title}
                                        </Link>
                                    </TD>
                                    <TD>{myRole ? t(`partyRole.${myRole}`) : '—'}</TD>
                                    <TD>{counterpartyName}</TD>
                                    <TD className="text-right tabular">{formatMoney(tx.amount, intl)}</TD>
                                    <TD>
                                        <TransactionStatusBadge status={tx.status} label={t(`status.${tx.status}`)} />
                                    </TD>
                                    <TD className="whitespace-nowrap text-muted-foreground">{fmtDate(tx.updatedAt, intl)}</TD>
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                </Card>
            )}
        </>
    );
}
