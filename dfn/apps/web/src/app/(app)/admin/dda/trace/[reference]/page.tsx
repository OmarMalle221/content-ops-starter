import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  Badge,
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
import { CopyButton } from '@/components/copy-button';
import { StatusBadge } from '@/components/status-badge';
import { DdaBanner } from '@/components/dda/dda-banner';
import type { DdaTraceResponse } from '@/components/dda/dda-types';
import { ApiError, apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Traçabilité DDA' };

const REFERENCE_RE = /^DDA-\d{4}-[A-Z0-9]{6}$/;

/** Full traceability of one simulated operation: row, DDA ledger posting and audit trail. ADMIN only. */
export default async function DdaTracePage({ params }: { params: Promise<{ reference: string }> }) {
  const [{ reference }, { t, locale }, session] = await Promise.all([params, getT(), getSession()]);
  if (!session || session.user.globalRole !== 'ADMIN') notFound();
  if (!REFERENCE_RE.test(reference)) notFound();
  let trace: DdaTraceResponse;
  try {
    trace = await apiFetch<DdaTraceResponse>(`/v1/admin/dda/trace/${reference}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const op = trace.operation;
  const ledger = trace.ledgerTransaction;

  return (
    <div className="space-y-6">
      <DdaBanner compact />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/dda"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden /> {t('ddaLab.trace.back')}
          </Link>
          <h2 className="mt-2 flex flex-wrap items-center gap-2 text-lg font-semibold">
            {t('ddaLab.trace.title')} · <span className="font-mono">{op.reference}</span>
            <StatusBadge status={op.status} />
            <Badge variant="sandbox">{t('app.sandbox')}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">{t('ddaLab.trace.description')}</p>
        </div>
        <CopyButton value={op.reference} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('ddaLab.trace.row')}</CardTitle>
          <CardDescription>
            {t(`ddaLab.operations.kinds.${op.operation}`)} · {formatDate(op.createdAt, locale, true)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <dt className="text-muted-foreground">{t('ddaLab.operations.organization')}</dt>
            <dd>
              {op.scope === 'PLATFORM' ? t('ddaLab.operations.platform') : (op.organization?.name ?? '—')}
            </dd>
            <dt className="text-muted-foreground">{t('ddaLab.operations.counterparty')}</dt>
            <dd>{op.counterparty?.name ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('ddaLab.operations.units')}</dt>
            <dd className="tabular-nums">
              {op.operation === 'RESERVE_ADJUSTMENT' ? '—' : formatMoney(op.units, locale)}
            </dd>
            <dt className="text-muted-foreground">{t('ddaLab.operations.reserveDelta')}</dt>
            <dd className="tabular-nums">
              {op.reserveDeltaUsd.minor === '0' ? '—' : formatMoney(op.reserveDeltaUsd, locale)}
            </dd>
            <dt className="text-muted-foreground">{t('ddaLab.operations.by')}</dt>
            <dd>
              {op.createdBy
                ? `${op.createdBy.firstName} ${op.createdBy.lastName} · ${op.createdBy.email}`
                : '—'}
            </dd>
            <dt className="text-muted-foreground">{t('ddaLab.trace.ledgerTransaction')}</dt>
            <dd className="font-mono text-xs">{op.ledgerTransactionId ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('ddaLab.forms.note')}</dt>
            <dd>{op.note ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('ddaLab.trace.metadata')}</dt>
            <dd>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                {JSON.stringify(op.metadata ?? {}, null, 2)}
              </pre>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ddaLab.trace.ledger')}</CardTitle>
          {ledger ? (
            <CardDescription>
              {t('ddaLab.trace.idempotencyKey')}: <span className="font-mono">{ledger.idempotencyKey}</span> ·{' '}
              {t('ddaLab.trace.kind')}: {ledger.kind} · {t('ddaLab.trace.posted')}:{' '}
              {formatDate(ledger.postedAt, locale, true)}
            </CardDescription>
          ) : (
            <CardDescription>{t('ddaLab.trace.ledgerNone')}</CardDescription>
          )}
        </CardHeader>
        {ledger ? (
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={ledger.status} />
              <span className="text-muted-foreground">{ledger.description}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ddaLab.trace.direction')}</TableHead>
                  <TableHead>{t('ddaLab.trace.account')}</TableHead>
                  <TableHead>{t('common.currency')}</TableHead>
                  <TableHead className="text-right">{t('ddaLab.trace.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.direction}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{e.account.code}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {e.account.type} · {e.account.normalBalance} · {e.account.ownerType}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.account.currencyCode}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(e.amount, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ddaLab.trace.audit')}</CardTitle>
        </CardHeader>
        <CardContent>
          {trace.audit.length === 0 ? (
            <EmptyState title={t('ddaLab.trace.auditEmpty')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ddaLab.trace.action')}</TableHead>
                  <TableHead>{t('ddaLab.trace.actor')}</TableHead>
                  <TableHead>{t('ddaLab.trace.ip')}</TableHead>
                  <TableHead>{t('common.date')}</TableHead>
                  <TableHead>{t('ddaLab.trace.metadata')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trace.audit.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">{a.action}</TableCell>
                    <TableCell className="text-sm">{a.actor?.email ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{a.ip ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(a.createdAt, locale, true)}
                    </TableCell>
                    <TableCell>
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {t('common.details')}
                        </summary>
                        <pre className="mt-1 max-w-md overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                          {JSON.stringify(a.metadata ?? {}, null, 2)}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{trace.disclaimer}</p>
    </div>
  );
}
