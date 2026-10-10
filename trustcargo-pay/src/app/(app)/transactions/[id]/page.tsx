import { TABS, TransactionDetail, type Tab } from '@/components/tx/transaction-detail';
import { getI18n } from '@/i18n/server';
import { requireActor } from '@/server/auth/session';
import { loadTransactionView } from '@/server/load-view';

export const metadata = { title: 'Transaction' };

export default async function TransactionPage({
    params,
    searchParams
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ tab?: string }>;
}) {
    const actor = await requireActor();
    const { id } = await params;
    const { tab } = await searchParams;
    const { t, intl } = await getI18n();
    const current = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'overview';
    const view = await loadTransactionView(actor, id, current === 'documents');
    return <TransactionDetail view={view} t={t} intl={intl} basePath={`/transactions/${id}`} tab={current} />;
}
