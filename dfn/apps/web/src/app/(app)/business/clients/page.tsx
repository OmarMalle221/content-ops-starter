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
import { apiFetch } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Clients' };

interface Counterparty {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  notes: string | null;
  linkedOrganizationId: string | null;
  createdAt: string;
}

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
                  <TableHead>{t('clientsX.linked')}</TableHead>
                  <TableHead>{t('common.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counterparties.map((c) => (
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
                    <TableCell>
                      <Badge variant={c.linkedOrganizationId ? 'success' : 'muted'}>
                        {c.linkedOrganizationId ? t('clientsX.linked') : t('clientsX.notLinked')}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(c.createdAt, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">{t('clientsX.linkedHint')}</p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
