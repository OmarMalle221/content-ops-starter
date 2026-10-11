import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { BusinessVerificationCard, InviteMemberCard } from '@/components/forms/business-forms';
import { apiFetch } from '@/lib/api-server';
import { resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Équipe' };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const ws = await resolveWorkspace(searchParams);
  const { t, organizationId, canManage } = ws;
  const org = await apiFetch<any>(`/v1/organizations/${organizationId}`);
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={t('bizTabs.team')}
        subtitle={t('business.subtitle')}
        basePath="/business/team"
      />
      <div className="grid gap-6 lg:grid-cols-2">
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
        {org.type !== 'BUSINESS' ? (
          <p className="text-sm text-muted-foreground">{t('bizTabs.noBusiness')}</p>
        ) : null}
      </div>
    </>
  );
}
