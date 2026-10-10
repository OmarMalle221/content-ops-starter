import { redirect } from 'next/navigation';
import { TABS, TransactionDetail, type Tab } from '@/components/tx/transaction-detail';
import { getI18n } from '@/i18n/server';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';
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
    if (actor.pendingPlatformRoles?.length) {
        // A staff account without a recent MFA reads only the transactions it is a party to; any other id leads to the
        // MFA challenge first, whether or not it exists (no existence oracle), then to the staff view or a 404.
        const app = await getApp();
        const asParty = await app.views.transaction(actor, id).then(
            () => true,
            () => false
        );
        if (!asParty) redirect(`/mfa?next=${encodeURIComponent(`/transactions/${id}?tab=${current}`)}`);
    }
    const view = await loadTransactionView(actor, id, current === 'documents');
    return <TransactionDetail view={view} t={t} intl={intl} basePath={`/transactions/${id}`} tab={current} />;
}
