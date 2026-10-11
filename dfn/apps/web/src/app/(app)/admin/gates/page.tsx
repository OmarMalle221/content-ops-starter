import { CheckCircle2, Clock, Landmark, Loader } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Stat } from '@dfn/ui';
import { GatesProvidersCard } from '@/components/admin/gates-providers-card';
import {
  GatesRegisterTable,
  type GatesListDto,
  type ProvidersDto,
} from '@/components/admin/gates-register-table';
import { GatesTrackingBanner } from '@/components/admin/gates-tracking-banner';
import { apiFetch } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Portes réglementaires' };

/**
 * Regulatory gates register (R1–R10) — COMPLIANCE and ADMIN (the admin layout already sends
 * USER accounts away). Tracking only: nothing on this page can activate live mode.
 */
export default async function AdminGatesPage() {
  const [{ t, locale }, data, providers] = await Promise.all([
    getT(),
    apiFetch<GatesListDto>('/v1/admin/gates'),
    apiFetch<ProvidersDto>('/v1/admin/gates/providers'),
  ]);
  const count = (status: string) => data.summary.byStatus[status] ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('gatesAdmin.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('gatesAdmin.subtitle')} · {t('app.sandbox')}
        </p>
      </div>

      <GatesTrackingBanner t={t} canManage={data.canManage} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={t('gatesAdmin.stats.total')}
          value={data.summary.total}
          hint={t('gatesAdmin.stats.totalHint')}
          icon={<Landmark />}
        />
        <Stat
          label={t('gatesAdmin.stats.inProgress')}
          value={count('IN_PROGRESS')}
          hint={t('gatesAdmin.stats.inProgressHint')}
          icon={<Loader />}
        />
        <Stat
          label={t('gatesAdmin.stats.pending')}
          value={count('PENDING_SECOND_APPROVAL')}
          hint={t('gatesAdmin.stats.pendingHint')}
          icon={<Clock />}
        />
        <Stat
          label={t('gatesAdmin.stats.satisfied')}
          value={count('SATISFIED')}
          hint={t('gatesAdmin.stats.satisfiedHint')}
          icon={<CheckCircle2 />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('gatesAdmin.register')}</CardTitle>
          <CardDescription>{t('gatesAdmin.registerHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <GatesRegisterTable gates={data.items} t={t} locale={locale} />
        </CardContent>
      </Card>

      <GatesProvidersCard providers={providers.providers} t={t} />

      <p className="text-xs text-muted-foreground">{t('gatesAdmin.docs')}</p>
    </div>
  );
}
