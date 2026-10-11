import Link from 'next/link';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { RiskAlertActions } from '@/components/admin/admin-actions';
import { apiFetch } from '@/lib/api-server';
import { formatDate, statusVariant } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminRiskPage() {
  const [{ t, locale }, data] = await Promise.all([
    getT(),
    apiFetch<any>('/v1/admin/risk-alerts?pageSize=100'),
  ]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.rule')}s</CardTitle>
          <CardDescription>Explainable, advisory only — no automatic refusal.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-xs sm:grid-cols-2">
            {data.rules.map((r: any) => (
              <li key={r.code} className="rounded-md border p-2">
                <p className="font-mono font-medium">{r.code}</p>
                <p className="text-muted-foreground">{r.description}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <div className="space-y-3">
        {data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.empty')}</p>
        ) : null}
        {data.items.map((a: any) => (
          <Card key={a.id}>
            <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(a.severity)}>{a.severity}</Badge>
                  <span className="font-mono text-sm font-medium">{a.ruleCode}</span>
                  <StatusBadge status={a.status} />
                  <span className="text-xs text-muted-foreground">
                    {t('admin.score')} {a.score}
                  </span>
                </div>
                <p className="text-sm">{a.explanation?.summary}</p>
                <p className="text-xs text-muted-foreground">{a.explanation?.recommendation}</p>
                <p className="text-xs text-muted-foreground">
                  {a.user?.email ?? ''}{' '}
                  {a.transaction ? (
                    <Link href={`/transactions/${a.transaction.id}`} className="text-primary hover:underline">
                      {a.transaction.reference}
                    </Link>
                  ) : null}{' '}
                  · {formatDate(a.createdAt, locale, true)}
                </p>
                {a.actions?.length ? (
                  <ul className="text-xs text-muted-foreground">
                    {a.actions.map((x: any) => (
                      <li key={x.id}>
                        {x.action} — {x.note} ({x.actor.firstName} {x.actor.lastName})
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <RiskAlertActions alert={a} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
