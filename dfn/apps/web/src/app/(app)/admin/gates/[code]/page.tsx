import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { GateActions } from '@/components/admin/gates-actions';
import { GatesHistory } from '@/components/admin/gates-history';
import { gateTitle, type GateActor, type GateDetailDto } from '@/components/admin/gates-register-table';
import { GateLevelBadge, GateStatusBadge } from '@/components/admin/gates-status-badge';
import { GatesTrackingBanner } from '@/components/admin/gates-tracking-banner';
import { ApiError, apiFetch, getSession } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import type { Locale } from '@/lib/i18n';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Porte réglementaire' };

const CODE_RE = /^R(10|[1-9])$/i;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Approval({
  actor,
  at,
  t,
  locale,
}: {
  actor: GateActor | null;
  at: string | null;
  t: (path: string) => string;
  locale: Locale;
}) {
  if (!actor) return <span className="text-muted-foreground">{t('gatesAdmin.notYet')}</span>;
  return (
    <span>
      {actor.name} <span className="text-muted-foreground">({actor.email})</span>
      {at ? (
        <span className="text-muted-foreground">
          {' '}
          · {t('gatesAdmin.on')} {formatDate(at, locale, true)}
        </span>
      ) : null}
    </span>
  );
}

/** One regulatory gate: details, approvals, history and (ADMIN only) the transition forms. */
export default async function AdminGatePage({ params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await params;
  if (!CODE_RE.test(rawCode)) notFound();
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  let gate: GateDetailDto;
  try {
    gate = await apiFetch<GateDetailDto>(`/v1/admin/gates/${rawCode.toUpperCase()}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const canManage = session?.user.globalRole === 'ADMIN';
  const youApprovedFirst =
    gate.status === 'PENDING_SECOND_APPROVAL' && gate.firstApprover?.id === session?.user.id;
  const kindLabel = (kind: string) => {
    const v = t(`gatesAdmin.kinds.${kind}`);
    return v === `gatesAdmin.kinds.${kind}` ? kind : v;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button asChild size="sm" variant="ghost" className="-ml-2">
            <Link href="/admin/gates">
              <ArrowLeft /> {t('gatesAdmin.back')}
            </Link>
          </Button>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <span className="font-mono">{gate.code}</span>
            <GateStatusBadge status={gate.status} t={t} />
            <GateLevelBadge level={gate.level} t={t} />
          </h2>
          <p className="max-w-3xl text-sm">{gateTitle(t, gate)}</p>
          <p className="text-xs text-muted-foreground">
            {gate.jurisdiction} · {t('app.sandbox')}
          </p>
        </div>
      </div>

      <GatesTrackingBanner t={t} canManage={canManage} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('gatesAdmin.columns.status')}</CardTitle>
            <CardDescription>
              {gate.approvals}/{gate.approvalsRequired} {t('gatesAdmin.approvals')}
              {gate.status === 'PENDING_SECOND_APPROVAL' ? ` — ${t('gatesAdmin.waitingSecond')}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label={t('gatesAdmin.referenceDoc')}>
                <span className="font-mono text-xs">{gate.referenceDoc}</span>
              </Field>
              <Field label={t('gatesAdmin.columns.updatedAt')}>
                {formatDate(gate.updatedAt, locale, true)}
              </Field>
              <Field label={t('gatesAdmin.evidence')}>
                {gate.evidenceRef ? (
                  <span className="break-all font-mono text-xs">{gate.evidenceRef}</span>
                ) : (
                  <span className="text-muted-foreground">{t('gatesAdmin.noEvidence')}</span>
                )}
              </Field>
              <Field label={t('gatesAdmin.requiredFor')}>
                {gate.requiredFor.length > 0
                  ? gate.requiredFor.map(kindLabel).join(' · ')
                  : t('gatesAdmin.requiredForNone')}
              </Field>
              <Field label={t('gatesAdmin.firstApprover')}>
                <Approval actor={gate.firstApprover} at={gate.firstApprovedAt} t={t} locale={locale} />
              </Field>
              <Field label={t('gatesAdmin.secondApprover')}>
                <Approval actor={gate.secondApprover} at={gate.secondApprovedAt} t={t} locale={locale} />
              </Field>
              <div className="sm:col-span-2">
                <Field label={t('gatesAdmin.notes')}>
                  {gate.notes ? (
                    <span className="whitespace-pre-wrap">{gate.notes}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('gatesAdmin.noNotes')}</span>
                  )}
                </Field>
              </div>
            </dl>
          </CardContent>
        </Card>

        {canManage ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('gatesAdmin.actions.title')}</CardTitle>
              <CardDescription>{t('gatesAdmin.fourEyes')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {youApprovedFirst ? (
                <p className="text-sm text-warning">{t('gatesAdmin.youApprovedFirst')}</p>
              ) : null}
              <GateActions code={gate.code} status={gate.status} nextActions={gate.nextActions} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('gatesAdmin.history')}</CardTitle>
          <CardDescription>{t('gatesAdmin.historyHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <GatesHistory events={gate.events} t={t} locale={locale} />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t('gatesAdmin.docs')}</p>
    </div>
  );
}
