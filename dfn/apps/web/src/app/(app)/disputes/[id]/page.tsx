import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { DisputePanel } from '@/components/disputes/dispute-panel';
import { ApiError, apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Litige' };

export default async function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  let d: any;
  try {
    d = await apiFetch<any>(`/v1/disputes/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const staff = session!.user.globalRole !== 'USER';
  const orgIds = session!.user.organizations.map((o) => o.id);
  const isParty =
    orgIds.includes(d.transaction.buyerOrganizationId) || orgIds.includes(d.transaction.sellerOrganizationId);
  return (
    <>
      <Link
        href="/disputes"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t('dispute.title')}
      </Link>
      <PageHeader
        title={`${t(`dispute.reasons.${d.reason}`)} — ${d.transaction.reference}`}
        subtitle={`${d.transaction.title} · ${formatMoney(d.transaction.amount, locale)} · ${t('roles.' + d.openedByRole)} · ${formatDate(d.openedAt, locale, true)}`}
        actions={<StatusBadge status={d.status} />}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('common.description')}</CardTitle>
              {d.appealDeadline ? (
                <CardDescription>Appeal until {formatDate(d.appealDeadline, locale, true)}</CardDescription>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{d.description}</p>
              {d.evidences.length ? (
                <ul className="space-y-1 text-sm">
                  {d.evidences.map((e: any) => (
                    <li key={e.id}>
                      <a
                        className="text-primary hover:underline"
                        href={`/api/v1/documents/${e.document.id}/download`}
                      >
                        {e.document.title}
                      </a>{' '}
                      <span className="text-xs text-muted-foreground">
                        ({t(`docs.kinds.${e.document.kind}`)})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('dispute.messages')}</CardTitle>
            </CardHeader>
            <CardContent>
              {d.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('common.empty')}</p>
              ) : null}
              <ul className="space-y-3">
                {d.messages.map((m: any) => (
                  <li
                    key={m.id}
                    className={`rounded-lg border p-3 ${m.internal ? 'border-dashed bg-muted/40' : ''}`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{m.author.name}</span>
                      {m.author.staff ? <Badge variant="secondary">{t('roles.STAFF')}</Badge> : null}
                      {m.internal ? <Badge variant="muted">internal</Badge> : null}
                      <span>{formatDate(m.createdAt, locale, true)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                    {m.document ? (
                      <a
                        className="mt-1 inline-block text-xs text-primary hover:underline"
                        href={`/api/v1/documents/${m.document.id}/download`}
                      >
                        📎 {m.document.title}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <DisputePanel dispute={d} staff={staff} isParty={isParty} />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('dispute.decisions')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {d.decisions.length === 0 ? <p className="text-muted-foreground">{t('common.empty')}</p> : null}
              {d.decisions.map((x: any) => (
                <div key={x.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{t(`dispute.outcomes.${x.outcome}`)}</span>
                    <Badge variant={x.executedAt ? 'success' : 'warning'}>
                      {x.executedAt ? 'executed' : x.isFinal ? 'final' : 'appealable'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">{x.rationale}</p>
                  {x.outcome === 'SPLIT' ? (
                    <p className="mt-1 text-xs tabular-nums">
                      {t('roles.SELLER')}: {x.sellerAmount.decimal} {x.sellerAmount.currency} ·{' '}
                      {t('roles.BUYER')}: {x.buyerAmount.decimal} {x.buyerAmount.currency}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {x.decidedBy} · {formatDate(x.createdAt, locale, true)}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('nav.transactions')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <Link href={`/transactions/${d.transaction.id}`} className="text-primary hover:underline">
                {d.transaction.reference}
              </Link>
              <div className="mt-2 flex items-center gap-2">
                <StatusBadge status={d.transaction.status} />
                {d.transaction.releaseFrozen ? (
                  <Badge variant="destructive">{t('dispute.frozen')}</Badge>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
