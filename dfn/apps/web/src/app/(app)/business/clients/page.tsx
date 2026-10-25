import { Users } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { CounterpartyCreateDialog } from '@/components/business/counterparty-create-dialog';
import { CounterpartyLinkActions } from '@/components/business/counterparty-link-actions';
import { apiFetch } from '@/lib/api-server';
import { formatDate, type BadgeVariant } from '@/lib/format';
import { resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Clients' };

/** Requester-side link status: REQUESTED merges "pending" and "no matching account" (no enumeration). */
type LinkStatus = 'NONE' | 'REQUESTED' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';

interface Counterparty {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  notes: string | null;
  linkedOrganizationId: string | null;
  link: {
    status: LinkStatus;
    requestedAt: string | null;
    decidedAt: string | null;
    linkedOrganization: { id: string; name: string | null } | null;
    requestAgainAfter: string | null;
    nextActions: string[];
  };
  createdAt: string;
}

const LINK_VARIANT: Record<LinkStatus, BadgeVariant> = {
  NONE: 'muted',
  REQUESTED: 'secondary',
  ACCEPTED: 'success',
  DECLINED: 'warning',
  REVOKED: 'muted',
};

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const ws = await resolveWorkspace(searchParams);
  const { t, locale, organizationId } = ws;
  const counterparties = await apiFetch<Counterparty[]>(`/v1/organizations/${organizationId}/counterparties`);
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={t('clientsX.title')}
        subtitle={t('clientsX.subtitle')}
        basePath="/business/clients"
        actions={ws.canCreateClients ? <CounterpartyCreateDialog organizationId={organizationId} /> : null}
      />
      {counterparties.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={t('clientsX.empty')}
          description={t('clientsX.emptyHint')}
          action={
            ws.canCreateClients ? <CounterpartyCreateDialog organizationId={organizationId} /> : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('clientsX.name')}</TableHead>
                  <TableHead>{t('clientsX.email')}</TableHead>
                  <TableHead>{t('clientsX.phone')}</TableHead>
                  <TableHead>{t('clientsX.country')}</TableHead>
                  <TableHead>{t('counterpartyLinks.column')}</TableHead>
                  <TableHead>{t('common.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counterparties.map((c) => {
                  const status: LinkStatus = c.link?.status ?? 'NONE';
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">
                        {c.name}
                        {c.notes ? (
                          <span className="block max-w-[16rem] truncate text-xs text-muted-foreground">
                            {c.notes}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{c.email ?? '—'}</TableCell>
                      <TableCell>{c.phone ?? '—'}</TableCell>
                      <TableCell>{c.country ?? '—'}</TableCell>
                      <TableCell className="space-y-1">
                        <Badge variant={LINK_VARIANT[status]}>
                          {t(`counterpartyLinks.status.${status}`)}
                        </Badge>
                        {status === 'ACCEPTED' && c.link.linkedOrganization?.name ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('counterpartyLinks.linkedTo')} {c.link.linkedOrganization.name}
                          </span>
                        ) : null}
                        {status === 'REQUESTED' && c.link.requestedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('counterpartyLinks.requestedOn')} {formatDate(c.link.requestedAt, locale)}
                          </span>
                        ) : null}
                        {(status === 'DECLINED' || status === 'REVOKED') && c.link.decidedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('counterpartyLinks.decidedOn')} {formatDate(c.link.decidedAt, locale)}
                          </span>
                        ) : null}
                        {c.link?.requestAgainAfter ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('counterpartyLinks.requestAgainAfter')}{' '}
                            {formatDate(c.link.requestAgainAfter, locale, true)}
                          </span>
                        ) : null}
                        {ws.canCreateClients ? (
                          <CounterpartyLinkActions
                            organizationId={organizationId}
                            counterpartyId={c.id}
                            nextActions={c.link?.nextActions ?? []}
                          />
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(c.createdAt, locale)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('clientsX.linkedHint')} {t('counterpartyLinks.consentHint')}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
