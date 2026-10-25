import { Card, CardContent, CardHeader, CardTitle, Stat } from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { apiFetch } from '@/lib/api-server';
import { formatMoney, moneyFromMinor } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminHome() {
  const [{ t, locale }, stats] = await Promise.all([getT(), apiFetch<any>('/v1/admin/stats')]);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.users')} value={stats.users} />
        <Stat label={t('admin.organizations')} value={stats.organizations} />
        <Stat label={t('admin.disputes')} value={stats.openDisputes} />
        <Stat
          label={t('admin.risk')}
          value={stats.openRiskAlerts}
          hint={`${stats.pendingVerifications} ${t('admin.verifications').toLowerCase()}`}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('nav.transactions')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {Object.entries(stats.transactions as Record<string, number>).map(([s, n]) => (
                <li key={s} className="flex items-center justify-between">
                  <StatusBadge status={s} />
                  <span className="tabular-nums">{n}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              {t('admin.volume')} ({t('common.simulated').toLowerCase()})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {stats.volumeByCurrency.map((v: any) => (
                <li key={v.currency} className="flex items-center justify-between">
                  <span>
                    {v.currency} · {v.count} {t('nav.transactions').toLowerCase()}
                  </span>
                  <span className="tabular-nums">
                    {formatMoney(moneyFromMinor(v.amountMinor, v.currency), locale)} · {t('admin.fees')}{' '}
                    {formatMoney(moneyFromMinor(v.feeMinor, v.currency), locale)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
