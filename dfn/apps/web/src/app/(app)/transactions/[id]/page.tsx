import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Check, FileText, Lock, ShieldCheck, X } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Stepper,
  type Step,
} from '@dfn/ui';
import { ScanBadge } from '@/components/documents/scan-badge';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { TransactionActions } from '@/components/transactions/transaction-actions';
import { MilestoneCard } from '@/components/transactions/milestone-card';
import { ContractView } from '@/components/transactions/contract-view';
import { ApiError, apiFetch } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Transaction' };

function buildSteps(tx: any, t: (k: string) => string): Step[] {
  const order = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'AWAITING_FUNDING', 'FUNDED', 'IN_PROGRESS', 'SETTLED'];
  const idx = tx.status === 'DISPUTED' ? 4 : tx.status === 'REFUNDED' ? 5 : order.indexOf(tx.status);
  const terminalBad = ['CANCELLED', 'EXPIRED'].includes(tx.status);
  const defs = [
    {
      key: 'invite',
      label: t('tx.steps.invite'),
      description: tx.seller?.status === 'ACCEPTED' ? tx.seller.organization?.name : tx.seller?.invitedEmail,
    },
    {
      key: 'terms',
      label: t('tx.steps.terms'),
      description:
        tx.contract?.status === 'ACCEPTED'
          ? t('status.ACCEPTED')
          : `${tx.contract?.currentVersion?.acceptances?.length ?? 0}/2`,
    },
    {
      key: 'verify',
      label: t('tx.steps.verify'),
      description: tx.verification.fundingAllowed
        ? t('status.SIMULATED_PASS')
        : `${tx.verification.reasons.length} ⚠`,
    },
    {
      key: 'fund',
      label: t('tx.steps.fund'),
      description: tx.fundedAt ? formatDate(tx.fundedAt) : t('common.simulated'),
    },
    {
      key: 'deliver',
      label: t('tx.steps.deliver'),
      description: `${tx.milestones.filter((m: any) => m.status === 'RELEASED').length}/${tx.milestones.length}`,
    },
    { key: 'close', label: t('tx.steps.close'), description: tx.settledAt ? formatDate(tx.settledAt) : '' },
  ];
  const doneCount = terminalBad
    ? 0
    : idx >= 3
      ? tx.status === 'SETTLED' || tx.status === 'REFUNDED'
        ? 6
        : idx === 3
          ? 4
          : 4
      : idx === 1
        ? 1
        : idx === 2
          ? tx.verification.fundingAllowed
            ? 3
            : 2
          : 0;
  return defs.map((d, i) => ({
    ...d,
    state: terminalBad
      ? i === 0
        ? 'blocked'
        : 'upcoming'
      : i < doneCount
        ? 'done'
        : i === doneCount
          ? tx.status === 'DISPUTED'
            ? 'blocked'
            : 'current'
          : 'upcoming',
  }));
}

export default async function TransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, locale } = await getT();
  let tx: any;
  let documents: any[] = [];
  let events: any[] = [];
  try {
    [tx, documents, events] = await Promise.all([
      apiFetch<any>(`/v1/transactions/${id}`),
      apiFetch<any[]>(`/v1/transactions/${id}/documents`),
      apiFetch<any[]>(`/v1/transactions/${id}/events`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const steps = buildSteps(tx, t);
  const party = (p: any) =>
    p ? (
      <div className="rounded-lg border p-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t(`roles.${p.role}`)}</p>
        <p className="font-medium">{p.organization?.name ?? p.invitedName ?? p.invitedEmail}</p>
        <p className="text-xs text-muted-foreground">
          {p.invitedEmail} {p.organization?.country ? `· ${p.organization.country}` : ''}
        </p>
        <div className="mt-1">
          <StatusBadge status={p.status} />
        </div>
      </div>
    ) : null;

  return (
    <>
      <Link
        href="/transactions"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t('tx.list')}
      </Link>
      <PageHeader
        title={tx.title}
        subtitle={`${tx.reference} · ${tx.category} · ${tx.originCountry} → ${tx.destinationCountry} · ${t(`roles.${tx.myRole}`)}`}
        actions={
          <div className="flex items-center gap-2">
            {tx.releaseFrozen ? (
              <Badge variant="destructive">
                <Lock className="mr-1 size-3" /> {t('dispute.frozen')}
              </Badge>
            ) : null}
            <StatusBadge status={tx.status} />
          </div>
        }
      />
      <Stepper steps={steps} className="mb-6" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('common.actions')}</CardTitle>
              <CardDescription>{t('app.sandbox')}</CardDescription>
            </CardHeader>
            <CardContent>
              <TransactionActions tx={tx} />
              {tx.nextActions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('common.empty')}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('tx.milestones')}</CardTitle>
              <CardDescription>
                {t('tx.escrow')}: <strong>{formatMoney(tx.escrowBalance, locale)}</strong> ·{' '}
                {t('tx.released')}: {formatMoney(tx.releasedTotal, locale)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {tx.milestones.map((m: any) => (
                  <MilestoneCard key={m.id} tx={tx} milestone={m} documents={documents} />
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('tx.contract')}</CardTitle>
              {tx.contract?.currentVersion ? (
                <CardDescription className="font-mono text-xs">
                  v{tx.contract.currentVersion.version} · {t('tx.contractHash')}:{' '}
                  {tx.contract.currentVersion.contentHash.slice(0, 16)}…
                </CardDescription>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
                  {tx.contract?.currentVersion?.acceptedByBuyer ? (
                    <Check className="size-3.5 text-success" />
                  ) : (
                    <X className="size-3.5 text-muted-foreground" />
                  )}{' '}
                  {t('roles.BUYER')}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
                  {tx.contract?.currentVersion?.acceptedBySeller ? (
                    <Check className="size-3.5 text-success" />
                  ) : (
                    <X className="size-3.5 text-muted-foreground" />
                  )}{' '}
                  {t('roles.SELLER')}
                </span>
                <StatusBadge status={tx.contract?.status ?? 'DRAFT'} />
              </div>
              {tx.contract?.currentVersion ? (
                <ContractView bodyText={tx.contract.currentVersion.bodyText} />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('tx.documents')}</CardTitle>
            </CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('common.empty')}</p>
              ) : (
                <ul className="divide-y">
                  {documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
                      <FileText className="size-4 text-muted-foreground" />
                      {d.downloadUrl ? (
                        <a
                          className="flex-1 truncate text-primary hover:underline"
                          href={`/api${d.downloadUrl.replace(/^\/api/, '')}`}
                        >
                          {d.title}
                        </a>
                      ) : (
                        <span
                          className="flex-1 truncate text-muted-foreground"
                          title={t('documentStorage.scan.blocked')}
                        >
                          {d.title}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">{t(`docs.kinds.${d.kind}`)}</span>
                      <span className="text-xs text-muted-foreground">
                        {(d.sizeBytes / 1024).toFixed(0)} Ko
                      </span>
                      <ScanBadge scan={d.scan} />
                      <StatusBadge status={d.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('tx.history')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-3 border-l pl-4">
                {events.map((e) => (
                  <li key={e.id} className="text-sm">
                    <span
                      className="absolute -left-[5px] mt-1.5 size-2 rounded-full bg-primary"
                      aria-hidden
                    />
                    <p className="font-medium">{e.type}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(e.createdAt, locale, true)}
                      {e.actor ? ` · ${e.actor.firstName} ${e.actor.lastName}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('common.amount')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tx.amount')}</span>
                <span className="font-semibold tabular-nums">{formatMoney(tx.amount, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tx.fee')}</span>
                <span className="tabular-nums">{formatMoney(tx.fee, locale)}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground">{t('tx.totalToFund')}</span>
                <span className="font-semibold tabular-nums">{formatMoney(tx.totalToFund, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tx.escrow')}</span>
                <span className="tabular-nums">{formatMoney(tx.escrowBalance, locale)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('tx.parties')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {party(tx.buyer)}
              {party(tx.seller)}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-primary" /> {t('tx.verification')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span>{t('roles.BUYER')}</span>
                <StatusBadge status={tx.verification.buyerIdentity} />
              </div>
              <div className="flex items-center justify-between">
                <span>{t('roles.SELLER')}</span>
                <StatusBadge status={tx.verification.sellerIdentity} />
              </div>
              {tx.verification.reasons.length ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {tx.verification.reasons.map((r: string) => (
                    <li key={r}>• {t(`tx.verif.${r}`)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-success">{t('status.SIMULATED_PASS')}</p>
              )}
              {!tx.verification.fundingAllowed && ['ACCEPTED', 'PENDING_ACCEPTANCE'].includes(tx.status) ? (
                <p className="text-xs text-muted-foreground">{t('tx.fundingBlocked')}</p>
              ) : null}
            </CardContent>
          </Card>

          {tx.funding ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('tx.funding')}</CardTitle>
                <CardDescription>
                  {tx.funding.provider?.name} · <StatusBadge status={tx.funding.status} />
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>
                  <span className="text-muted-foreground">{t('tx.fundingRef')}:</span>{' '}
                  <code className="text-xs">{tx.funding.reference}</code>
                </p>
                <p className="tabular-nums">{formatMoney(tx.funding.amount, locale)}</p>
                {tx.funding.status === 'PENDING' ? (
                  <div className="rounded-md border border-dashed bg-muted/40 p-3 text-xs">
                    <p className="mb-1 font-medium">{t('tx.fundingInstructions')}</p>
                    <p>{tx.funding.instructions?.beneficiaryName}</p>
                    <p>{tx.funding.instructions?.beneficiaryAccount}</p>
                    <p className="mt-1 text-muted-foreground">{tx.funding.instructions?.notice}</p>
                    <p className="mt-2 text-muted-foreground">{t('tx.fundingWaiting')}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {tx.disputes?.length ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('tx.disputes')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {tx.disputes.map((d: any) => (
                  <Link
                    key={d.id}
                    href={`/disputes/${d.id}`}
                    className="flex items-center justify-between rounded-md border p-2 hover:bg-muted/40"
                  >
                    <span>{t(`dispute.reasons.${d.reason}`)}</span>
                    <StatusBadge status={d.status} />
                  </Link>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
