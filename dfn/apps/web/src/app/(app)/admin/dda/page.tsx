import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookOpen, FlaskConical, Landmark, PieChart, Users } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { DdaBanner } from '@/components/dda/dda-banner';
import { DdaSimulators } from '@/components/dda/dda-simulators';
import { DdaStressTester } from '@/components/dda/dda-stress-tester';
import {
  DDA_DOCS,
  formatBps,
  type DdaHoldingsResponse,
  type DdaOperationsResponse,
  type DdaOrganizationsResponse,
  type DdaOverview,
} from '@/components/dda/dda-types';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Laboratoire DDA' };

const PAGE_SIZE = 20;

/**
 * Diaspora Digital Asset research lab — platform ADMIN only. COMPLIANCE staff can reach /admin but
 * this surface does not exist for them (404, never 403): the fictitious asset is never exposed
 * outside the administrators who own the research sandbox.
 */
export default async function AdminDdaPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const [sp, { t, locale }, session] = await Promise.all([searchParams, getT(), getSession()]);
  if (!session || session.user.globalRole !== 'ADMIN') notFound();
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const [overview, holdings, operations, organizations] = await Promise.all([
    apiFetch<DdaOverview>('/v1/admin/dda/overview'),
    apiFetch<DdaHoldingsResponse>('/v1/admin/dda/holdings'),
    apiFetch<DdaOperationsResponse>(`/v1/admin/dda/operations?page=${page}&pageSize=${PAGE_SIZE}`),
    apiFetch<DdaOrganizationsResponse>('/v1/admin/dda/organizations'),
  ]);
  const totalPages = Math.max(1, Math.ceil(operations.total / operations.pageSize));
  const coverage = formatBps(overview.coverageRatioBps, locale);
  const redLines = ['chain', 'money', 'conversion', 'exposure', 'parity'] as const;

  return (
    <div className="space-y-6">
      <DdaBanner />

      <div>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          <FlaskConical className="size-5 text-muted-foreground" aria-hidden />
          {t('ddaLab.title')}
          <Badge variant="sandbox">{t('app.sandbox')}</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">{t('ddaLab.subtitle')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('ddaLab.kpi.supply')}
          value={formatMoney(overview.supply, locale)}
          hint={overview.invariantHolds ? t('ddaLab.kpi.invariantOk') : t('ddaLab.kpi.invariantBroken')}
          icon={<FlaskConical />}
        />
        <Stat
          label={t('ddaLab.kpi.reserve')}
          value={formatMoney(overview.reserveUsd, locale)}
          hint={t('ddaLab.kpi.reserveHint')}
          icon={<Landmark />}
        />
        <Stat
          label={t('ddaLab.kpi.coverage')}
          value={overview.coverageRatioBps === null ? t('ddaLab.kpi.noSupply') : coverage}
          hint={t('ddaLab.kpi.coverageHint')}
          icon={<PieChart />}
        />
        <Stat
          label={t('ddaLab.kpi.holders')}
          value={overview.holdersCount}
          hint={`${overview.operationsCount} ${t('ddaLab.kpi.operations')}`}
          icon={<Users />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('ddaLab.forms.title')}</CardTitle>
          <CardDescription>{t('ddaLab.forms.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <DdaSimulators organizations={organizations.items} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('ddaLab.stress.title')}</CardTitle>
            <CardDescription>{t('ddaLab.stress.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <DdaStressTester />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('ddaLab.redLines.title')}</CardTitle>
            <CardDescription>{t('ddaLab.docs.notice')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {redLines.map((key) => (
                <li key={key}>{t(`ddaLab.redLines.${key}`)}</li>
              ))}
            </ul>
            <div className="mt-4 space-y-1 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <BookOpen className="size-4 text-muted-foreground" aria-hidden /> {t('ddaLab.docs.title')}
              </p>
              <p className="text-xs text-muted-foreground">{t('ddaLab.docs.description')}</p>
              <ul className="space-y-1 font-mono text-xs">
                <li>
                  {DDA_DOCS.architecture}
                  <span className="ml-2 font-sans text-muted-foreground">
                    — {t('ddaLab.docs.architecture')}
                  </span>
                </li>
                <li>
                  {DDA_DOCS.compliance}
                  <span className="ml-2 font-sans text-muted-foreground">
                    — {t('ddaLab.docs.compliance')}
                  </span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('ddaLab.holdings.title')}</CardTitle>
          <CardDescription>
            {t('ddaLab.holdings.description')} · {t('ddaLab.kpi.supply').toLowerCase()}{' '}
            {formatMoney(holdings.supply, locale)} · Σ {formatMoney(holdings.sumHoldings, locale)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {holdings.items.length === 0 ? (
            <EmptyState title={t('ddaLab.holdings.empty')} description={t('app.sandbox')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ddaLab.holdings.organization')}</TableHead>
                  <TableHead>{t('ddaLab.holdings.account')}</TableHead>
                  <TableHead className="text-right">{t('ddaLab.holdings.balance')}</TableHead>
                  <TableHead className="text-right">{t('ddaLab.holdings.share')}</TableHead>
                  <TableHead className="text-right">{t('ddaLab.holdings.entries')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {holdings.items.map((h) => (
                  <TableRow key={h.accountId}>
                    <TableCell className="font-medium">
                      {h.organization.name}{' '}
                      <span className="text-xs text-muted-foreground">
                        {h.organization.type ?? ''} {h.organization.country ?? ''}
                        {h.organization.deleted ? ` · ${t('ddaLab.holdings.deleted')}` : ''}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{h.accountCode}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(h.balance, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatBps(h.shareBps, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.entryCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ddaLab.operations.title')}</CardTitle>
          <CardDescription>
            {t('ddaLab.operations.description')} · {operations.total} {t('ddaLab.kpi.operations')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {operations.items.length === 0 ? (
            <EmptyState title={t('ddaLab.operations.empty')} description={t('app.sandbox')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ddaLab.operations.reference')}</TableHead>
                  <TableHead>{t('ddaLab.operations.operation')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('ddaLab.operations.organization')}</TableHead>
                  <TableHead>{t('ddaLab.operations.counterparty')}</TableHead>
                  <TableHead className="text-right">{t('ddaLab.operations.units')}</TableHead>
                  <TableHead className="text-right">{t('ddaLab.operations.reserveDelta')}</TableHead>
                  <TableHead>{t('ddaLab.operations.by')}</TableHead>
                  <TableHead>{t('ddaLab.operations.date')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {operations.items.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell className="font-mono text-xs">{op.reference}</TableCell>
                    <TableCell className="text-sm">{t(`ddaLab.operations.kinds.${op.operation}`)}</TableCell>
                    <TableCell>
                      <StatusBadge status={op.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {op.scope === 'PLATFORM' ? (
                        <span className="text-muted-foreground">{t('ddaLab.operations.platform')}</span>
                      ) : (
                        (op.organization?.name ?? '—')
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{op.counterparty?.name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {op.operation === 'RESERVE_ADJUSTMENT' ? '—' : formatMoney(op.units, locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {op.reserveDeltaUsd.minor === '0' ? '—' : formatMoney(op.reserveDeltaUsd, locale)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {op.createdBy?.email ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(op.createdAt, locale, true)}
                    </TableCell>
                    <TableCell>
                      <Link
                        className="text-sm underline-offset-4 hover:underline"
                        href={`/admin/dda/trace/${op.reference}`}
                      >
                        {t('ddaLab.operations.trace')}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {t('ddaLab.operations.page')} {operations.page} / {totalPages}
              </span>
              <div className="flex gap-2">
                {operations.page > 1 ? (
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`/admin/dda?page=${operations.page - 1}`}
                  >
                    ← {t('ddaLab.operations.previous')}
                  </Link>
                ) : null}
                {operations.page < totalPages ? (
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`/admin/dda?page=${operations.page + 1}`}
                  >
                    {t('ddaLab.operations.next')} →
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{overview.disclaimer}</p>
    </div>
  );
}
