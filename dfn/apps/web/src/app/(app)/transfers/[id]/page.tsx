import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, Landmark, ShieldAlert } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Stat,
  Stepper,
  type Step,
} from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { CopyButton } from '@/components/copy-button';
import { TransferActions } from '@/components/transfers/transfer-actions';
import type { TransferDto, TransferEventDto } from '@/components/transfers/types';
import { ApiError, apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Transfert' };

/** Event payload fields shown in the history, in this order; ids, flags and raw enums stay hidden. */
const EVENT_FIELDS = [
  'reason',
  'note',
  'failureReason',
  'provider',
  'externalRef',
  'purpose',
  'refunded',
] as const;

function buildSteps(x: TransferDto, t: (k: string) => string, locale: 'fr' | 'en'): Step[] {
  const terminalBad = ['CANCELLED', 'EXPIRED'].includes(x.status);
  const review = x.status === 'REVIEW_REQUIRED';
  const authorized = Boolean(x.authorizedAt);
  const defs = [
    {
      key: 'quoted',
      label: t('xfer.timeline.quoted'),
      description: x.quotedAt ? formatDate(x.quotedAt, locale, true) : '',
    },
    {
      key: 'authorized',
      label: t('xfer.timeline.authorized'),
      description: review
        ? t('status.REVIEW_REQUIRED')
        : x.authorizedAt
          ? formatDate(x.authorizedAt, locale, true)
          : terminalBad
            ? t(`status.${x.status}`)
            : t('common.simulated'),
    },
    {
      key: 'processing',
      label: t('xfer.timeline.processing'),
      description: x.processingAt ? `${x.provider ?? ''} · ${formatDate(x.processingAt, locale, true)}` : '',
    },
    {
      key: 'settled',
      label: t('xfer.timeline.settled'),
      description:
        x.status === 'SETTLED'
          ? formatDate(x.settledAt, locale, true)
          : x.status === 'FAILED'
            ? `${t('status.FAILED')} · ${formatDate(x.failedAt, locale, true)}`
            : '',
    },
  ];
  const states: Step['state'][] = (() => {
    if (terminalBad) return ['done', 'blocked', 'upcoming', 'upcoming'];
    if (review) return ['done', 'blocked', 'upcoming', 'upcoming'];
    if (x.status === 'QUOTED') return ['done', 'current', 'upcoming', 'upcoming'];
    if (x.status === 'PROCESSING') return ['done', 'done', 'current', 'upcoming'];
    if (x.status === 'SETTLED') return ['done', 'done', 'done', 'done'];
    if (x.status === 'FAILED') return ['done', 'done', 'done', 'blocked'];
    return ['done', authorized ? 'done' : 'current', 'upcoming', 'upcoming'];
  })();
  return defs.map((d, i) => ({ ...d, state: states[i] }));
}

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  let x: TransferDto;
  try {
    x = await apiFetch<TransferDto>(`/v1/transfers/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const steps = buildSteps(x, t, locale);
  const eventLabel = (type: string) => {
    const key = `xfer.events.${type.replace('transfer.', '')}`;
    const label = t(key);
    return label === key ? type : label;
  };
  const colon = locale === 'fr' ? ' : ' : ': ';
  const eventDetails = (payload: TransferEventDto['payload']): string[] =>
    payload
      ? EVENT_FIELDS.flatMap((field) => {
          const value = payload[field];
          if (typeof value !== 'string' && typeof value !== 'number') return [];
          const purposeKey = `xfer.purposes.${value}`;
          const text = field === 'purpose' && t(purposeKey) !== purposeKey ? t(purposeKey) : String(value);
          return [`${t(`xfer.eventFields.${field}`)}${colon}${text}`];
        })
      : [];

  return (
    <>
      <Link
        href={`/transfers?organizationId=${x.organizationId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> {t('xfer.backToList')}
      </Link>
      <PageHeader
        title={x.reference}
        subtitle={`${x.organization?.name ?? ''} · ${x.originCountry} → ${x.destinationCountry} · ${x.purpose ? t(`xfer.purposes.${x.purpose}`) : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="sandbox">{t('app.sandbox')}</Badge>
            <StatusBadge status={x.status} entity="transfer" />
            <CopyButton value={x.reference} />
          </div>
        }
      />

      <Stepper steps={steps} className="mb-6" />

      {x.status === 'REVIEW_REQUIRED' ? (
        <Alert variant="warning" className="mb-6">
          <ShieldAlert className="size-4" />
          <AlertTitle>{t('status.REVIEW_REQUIRED')}</AlertTitle>
          <AlertDescription>
            {t('xfer.reviewRequired')}
            {x.reviewReason ? (
              <>
                {' '}
                <span className="font-medium">{t('xfer.reviewReason')}:</span> {x.reviewReason}
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {x.status === 'FAILED' ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>{t('status.FAILED')}</AlertTitle>
          <AlertDescription>
            {t('xfer.failedInfo')}
            {x.failureReason ? ` — ${x.failureReason}` : ''}
          </AlertDescription>
        </Alert>
      ) : null}
      {x.status === 'EXPIRED' ? (
        <Alert className="mb-6">
          <AlertDescription>{t('xfer.expiredInfo')}</AlertDescription>
        </Alert>
      ) : null}
      {x.status === 'CANCELLED' ? (
        <Alert className="mb-6">
          <AlertDescription>
            {t('xfer.cancelledInfo')}
            {x.cancelReason ? ` — ${x.cancelReason}` : ''}
          </AlertDescription>
        </Alert>
      ) : null}
      {x.status === 'PROCESSING' ? (
        <Alert className="mb-6">
          <AlertDescription>{t('xfer.processingInfo')}</AlertDescription>
        </Alert>
      ) : null}
      {x.status === 'SETTLED' ? (
        <Alert variant="success" className="mb-6">
          <AlertDescription>{t('xfer.settledInfo')}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-6">
        <TransferActions transfer={x} mfaEnabled={session?.user.mfaEnabled ?? false} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('xfer.amount')} value={formatMoney(x.source, locale)} hint={x.sourceCurrency} />
        <Stat
          label={t('xfer.fee')}
          value={formatMoney(x.fee, locale)}
          hint={x.feeBps !== null ? `${x.feeBps} bps` : undefined}
        />
        <Stat
          label={t('xfer.totalDebit')}
          value={formatMoney(x.totalDebit, locale)}
          hint={t('common.simulated')}
        />
        <Stat
          label={t('xfer.received')}
          value={<span className="text-primary">{formatMoney(x.destination, locale)}</span>}
          hint={x.rate.display}
          icon={<ArrowRight />}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('xfer.beneficiary')}</CardTitle>
            <CardDescription>{t('beneficiary.encryptedHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('beneficiary.name')}</dt>
                <dd className="font-medium">{x.beneficiary.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.account')}</dt>
                <dd className="font-mono">{x.beneficiary.accountIdentifierMasked}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.method')}</dt>
                <dd>{t(`xfer.methods.${x.beneficiary.method}`)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.institution')}</dt>
                <dd>{x.beneficiary.institutionName ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('beneficiary.country')}</dt>
                <dd>
                  {x.beneficiary.country} · {x.beneficiary.currencyCode}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Landmark className="size-4" /> {t('common.details')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.rate')}</dt>
                <dd className="tabular-nums">{x.rate.display}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.spread')}</dt>
                <dd className="tabular-nums">{x.spreadBps ?? '—'} bps</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.provider')}</dt>
                <dd>{x.provider ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.externalRef')}</dt>
                <dd className="font-mono text-xs">{x.externalRef ?? '—'}</dd>
              </div>
              {x.clientReference ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('xfer.clientReference')}</dt>
                  <dd>{x.clientReference}</dd>
                </div>
              ) : null}
              {x.quoteExpiresAt && x.status === 'QUOTED' ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('xfer.quoteExpires')}</dt>
                  <dd>{formatDate(x.quoteExpiresAt, locale, true)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t('xfer.createdAt')}</dt>
                <dd>{formatDate(x.createdAt, locale, true)}</dd>
              </div>
              {x.authorizedAt ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('xfer.authorizedAt')}</dt>
                  <dd>{formatDate(x.authorizedAt, locale, true)}</dd>
                </div>
              ) : null}
              {x.settledAt ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('xfer.settledAt')}</dt>
                  <dd>{formatDate(x.settledAt, locale, true)}</dd>
                </div>
              ) : null}
              {x.failedAt ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('xfer.failedAt')}</dt>
                  <dd>{formatDate(x.failedAt, locale, true)}</dd>
                </div>
              ) : null}
              {x.reviewNote ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('xfer.reviewNote')}</dt>
                  <dd className="text-right">{x.reviewNote}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('xfer.ledger')}</CardTitle>
            <CardDescription>{t('app.sandbox')}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-xs">
              {(
                [
                  ['sourceLedger', x.ledger.sourceLedgerTransactionId],
                  ['destinationLedger', x.ledger.destinationLedgerTransactionId],
                  ['reversalLedger', x.ledger.reversalLedgerTransactionId],
                ] as const
              ).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-muted-foreground">{t(`xfer.${key}`)}</dt>
                  <dd className="break-all font-mono">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('xfer.history')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            {x.events.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-1 border-l-2 border-muted pl-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <p className="font-medium">{eventLabel(e.type)}</p>
                  {eventDetails(e.payload).length ? (
                    <p className="text-xs text-muted-foreground">{eventDetails(e.payload).join(' · ')}</p>
                  ) : null}
                </div>
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDate(e.createdAt, locale, true)} ·{' '}
                  {e.actorUserId ? t('xfer.by') + ' ' + e.actorUserId.slice(0, 8) : t('xfer.system')}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
