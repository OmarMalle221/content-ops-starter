import Link from 'next/link';
import { Link2, ShieldAlert } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { LinkRequestActions } from '@/components/business/link-request-actions';
import { apiFetch } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Liaisons clients' };

interface LinkRequest {
  counterpartyId: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  requesterOrganization: { id: string; name: string; type: string; country: string };
  counterpartyName: string;
  counterpartyEmail: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  nextActions: string[];
}

interface LinkRequestList {
  items: LinkRequest[];
}

/**
 * Target side of the counterparty link consent: requests received by the selected organisation
 * (accept / decline, OWNER / ADMIN only) and the links already accepted.
 */
export default async function LinksPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const ws = await resolveWorkspace(searchParams);
  const { t, locale, organizationId, qs } = ws;
  const orgType = (type: string) => {
    const key = `counterpartyLinks.orgTypes.${type}`;
    const label = t(key);
    return label === key ? type : label;
  };
  const header = (
    <BusinessHeader
      ws={ws}
      title={t('counterpartyLinks.title')}
      subtitle={t('counterpartyLinks.subtitle')}
      basePath="/business/links"
    />
  );
  if (!ws.canDecideLinks) {
    return (
      <>
        {header}
        <EmptyState
          icon={<ShieldAlert />}
          title={t('counterpartyLinks.noAccess')}
          description={t('counterpartyLinks.noAccessHint')}
        />
      </>
    );
  }
  const base = `/v1/organizations/${organizationId}/link-requests`;
  const [pending, accepted] = await Promise.all([
    apiFetch<LinkRequestList>(`${base}?status=PENDING`),
    apiFetch<LinkRequestList>(`${base}?status=ACCEPTED`),
  ]);
  return (
    <>
      {header}
      <Card>
        <CardHeader>
          <CardTitle>{t('counterpartyLinks.received')}</CardTitle>
          <CardDescription>
            {t('counterpartyLinks.receivedHint')} · {t('app.sandbox')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.items.length === 0 ? (
            <EmptyState
              icon={<Link2 />}
              title={t('counterpartyLinks.noRequests')}
              description={t('counterpartyLinks.noRequestsHint')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('counterpartyLinks.requester')}</TableHead>
                  <TableHead>{t('counterpartyLinks.enteredAs')}</TableHead>
                  <TableHead>{t('counterpartyLinks.date')}</TableHead>
                  <TableHead>{t('counterpartyLinks.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.items.map((r) => (
                  <TableRow key={r.counterpartyId}>
                    <TableCell className="font-medium">
                      {r.requesterOrganization.name}
                      <span className="block text-xs text-muted-foreground">
                        {orgType(r.requesterOrganization.type)} · {r.requesterOrganization.country}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.counterpartyName}
                      {r.counterpartyEmail ? (
                        <span className="block text-xs text-muted-foreground">{r.counterpartyEmail}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(r.requestedAt, locale)}</TableCell>
                    <TableCell>
                      <LinkRequestActions
                        organizationId={organizationId}
                        counterpartyId={r.counterpartyId}
                        requesterName={r.requesterOrganization.name}
                        nextActions={r.nextActions}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>{t('counterpartyLinks.active')}</CardTitle>
            <CardDescription>{t('counterpartyLinks.activeHint')}</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={`/business/invoices?${qs}&scope=RECEIVED`}>{t('invoicing.received')}</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {accepted.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('counterpartyLinks.noActive')}</p>
          ) : (
            <ul className="divide-y text-sm">
              {accepted.items.map((r) => (
                <li key={r.counterpartyId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="font-medium">{r.requesterOrganization.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.counterpartyName} · {t('counterpartyLinks.decidedOn')}{' '}
                      {formatDate(r.decidedAt, locale)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="success">{t('counterpartyLinks.status.ACCEPTED')}</Badge>
                    <LinkRequestActions
                      organizationId={organizationId}
                      counterpartyId={r.counterpartyId}
                      requesterName={r.requesterOrganization.name}
                      nextActions={r.nextActions}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
