import { PageHeader } from '@/components/shell/page-header';
import { NewTransactionForm } from '@/components/transactions/new-transaction-form';
import { getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Nouvelle transaction' };

export default async function NewTransactionPage() {
  const [{ t }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations.filter((o) => ['OWNER', 'ADMIN', 'MEMBER'].includes(o.role));
  return (
    <>
      <PageHeader title={t('tx.new')} subtitle={t('app.sandboxLong')} />
      <NewTransactionForm organizations={orgs} defaultCountry={session!.user.country ?? 'CA'} />
    </>
  );
}
