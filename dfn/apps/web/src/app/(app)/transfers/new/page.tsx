import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Permission, orgRoleHas, type OrgRole } from '@dfn/shared';
import { Badge } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { NewTransferFlow, type WalletBalance } from '@/components/transfers/new-transfer-flow';
import type { BeneficiaryDto } from '@/components/transfers/types';
import { OrgPicker } from '@/components/wallet/org-picker';
import { apiFetchOptional, getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Nouveau transfert' };

export default async function NewTransferPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const sp = await searchParams;
  const [{ t }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId) ? sp.organizationId : orgs[0].id;
  const org = orgs.find((o) => o.id === organizationId)!;
  const [beneficiaries, summary] = await Promise.all([
    apiFetchOptional<{ items: BeneficiaryDto[] }>(`/v1/beneficiaries?organizationId=${organizationId}`),
    apiFetchOptional<{ currencies: WalletBalance[] }>(`/v1/wallets/${organizationId}/summary`),
  ]);
  return (
    <>
      <Link
        href={`/transfers?organizationId=${organizationId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t('xfer.backToList')}
      </Link>
      <PageHeader
        title={t('xfer.newTitle')}
        subtitle={`${org.name} · ${t('xfer.newSubtitle')}`}
        actions={<OrgPicker organizations={orgs} value={organizationId} basePath="/transfers/new" />}
      />
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
        <span>{t('app.sandboxLong')}</span>
      </div>
      <NewTransferFlow
        organizationId={organizationId}
        beneficiaries={beneficiaries?.items ?? []}
        walletBalances={(summary?.currencies ?? []).map((c) => ({
          currencyCode: c.currencyCode,
          balance: c.balance,
        }))}
        mfaEnabled={session!.user.mfaEnabled}
        canAuthorize={orgRoleHas(org.role as OrgRole, Permission.TRANSFER_AUTHORIZE)}
      />
    </>
  );
}
