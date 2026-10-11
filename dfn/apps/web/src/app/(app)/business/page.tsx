import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Stat } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { OrgPicker } from '@/components/wallet/org-picker';
import {
  BusinessVerificationCard,
  CreateOrganizationDialog,
  InviteMemberCard,
} from '@/components/forms/business-forms';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Entreprise' };

export default async function BusinessPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const sp = await searchParams;
  const [{ t, locale }, session, orgs] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any[]>('/v1/organizations'),
  ]);
  const businesses = orgs.filter((o) => o.type === 'BUSINESS');
  const selectedId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId)
      ? sp.organizationId
      : (businesses[0]?.id ?? orgs[0]?.id);
  const [org, txs, wallet] = await Promise.all([
    apiFetch<any>(`/v1/organizations/${selectedId}`),
    apiFetch<any>(`/v1/transactions?organizationId=${selectedId}&pageSize=100`),
    apiFetch<any>(`/v1/wallets/${selectedId}`),
  ]);
  const myRole = session!.user.organizations.find((o) => o.id === selectedId)?.role;
  const canManage = myRole === 'OWNER' || myRole === 'ADMIN' || session!.user.globalRole !== 'USER';
  const active = txs.items.filter(
    (x: any) => !['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'].includes(x.status),
  ).length;
  const settled = txs.items.filter((x: any) => x.status === 'SETTLED').length;
  const disputed = txs.items.filter((x: any) => x.openDisputes > 0).length;
  const cad = wallet.wallets.find((w: any) => w.currencyCode === 'CAD');
  return (
    <>
      <PageHeader
        title={t('business.title')}
        subtitle={t('business.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <OrgPicker organizations={orgs} value={selectedId} basePath="/business" />
            <CreateOrganizationDialog />
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{org.name}</h2>
        <Badge variant={org.type === 'BUSINESS' ? 'default' : 'muted'}>
          {org.type === 'BUSINESS' ? 'BUSINESS' : t('business.personal')}
        </Badge>
        <StatusBadge status={org.verificationStatus} />
        {myRole ? <Badge variant="secondary">{myRole}</Badge> : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('nav.transactions')}
          value={txs.total}
          hint={`${active} ${t('status.IN_PROGRESS').toLowerCase()}`}
        />
        <Stat label={t('status.SETTLED')} value={settled} />
        <Stat label={t('nav.disputes')} value={disputed} />
        <Stat
          label={`${t('nav.wallet')} CAD`}
          value={cad ? formatMoney(cad.balance, locale) : '—'}
          hint={t('app.sandbox')}
        />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('business.members')}</CardTitle>
            <CardDescription>{org.members.length}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {org.members.map((m: any) => (
                <li key={m.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium">
                      {m.user.firstName} {m.user.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  <Badge variant="secondary">{m.role}</Badge>
                </li>
              ))}
            </ul>
            {org.invitations?.length ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {org.invitations.length} invitation(s) {t('status.PENDING').toLowerCase()}
              </p>
            ) : null}
          </CardContent>
        </Card>
        {canManage && org.type === 'BUSINESS' ? <InviteMemberCard organizationId={org.id} /> : null}
        {canManage && org.type === 'BUSINESS' ? <BusinessVerificationCard org={org} /> : null}
      </div>
    </>
  );
}
