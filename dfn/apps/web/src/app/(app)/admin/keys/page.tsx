import { notFound } from 'next/navigation';
import { HardDrive, KeyRound, RefreshCw, ShieldAlert } from 'lucide-react';
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
  EmptyState,
  Stat,
} from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import {
  KeysPurposeCard,
  KeysRunTable,
  formatCount,
  type KeysStatus,
} from '@/components/admin/keys-purpose-table';
import { KeysRotateButton } from '@/components/admin/keys-rotate-button';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Clés et stockage' };

const PROCEDURE_STEPS = ['step1', 'step2', 'step3', 'step4', 'step5'] as const;

/**
 * Key ring console — platform ADMIN only. COMPLIANCE staff can reach /admin but this surface does
 * not exist for them (404, never 403). Shows key ids and value counts only: key material never
 * leaves the API.
 */
export default async function AdminKeysPage() {
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  if (!session || session.user.globalRole !== 'ADMIN') notFound();
  const data = await apiFetch<KeysStatus>('/v1/admin/keys');
  const canRotate = data.nextActions.includes('ROTATE');
  const driverLabel = (driver: string) => {
    const label = t(`keysAdmin.drivers.${driver}`);
    return label === `keysAdmin.drivers.${driver}` ? driver : label;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('keysAdmin.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('keysAdmin.subtitle')} · {t('app.sandbox')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('keysAdmin.noSecret')}</p>
        </div>
        {canRotate ? (
          <KeysRotateButton label={t('keysAdmin.rotate')} />
        ) : (
          <Badge variant="success">{t('keysAdmin.upToDateShort')}</Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('keysAdmin.values')}
          value={formatCount(data.totals.values, locale)}
          hint={t('keysAdmin.valuesHint')}
          icon={<KeyRound />}
        />
        <Stat
          label={t('keysAdmin.pending')}
          value={formatCount(data.totals.pendingRotation, locale)}
          hint={t('keysAdmin.pendingHint')}
          icon={<RefreshCw />}
        />
        <Stat
          label={t('keysAdmin.unreadable')}
          value={formatCount(data.totals.unreadable, locale)}
          hint={t('keysAdmin.unreadableHint')}
          icon={<ShieldAlert />}
        />
        <Stat
          label={t('keysAdmin.storage')}
          value={driverLabel(data.storage.activeDriver)}
          hint={
            data.storage.documentsByDriver.length > 0
              ? data.storage.documentsByDriver
                  .map((d) => `${formatCount(d.count, locale)} ${t('keysAdmin.documentsOn')} ${d.driver}`)
                  .join(' · ')
              : t('keysAdmin.storageHint')
          }
          icon={<HardDrive />}
        />
      </div>

      {data.totals.unreadable > 0 ? (
        <Alert variant="destructive">
          <ShieldAlert className="size-4" />
          <AlertTitle>{t('keysAdmin.unreadableTitle')}</AlertTitle>
          <AlertDescription>{t('keysAdmin.unreadableAlert')}</AlertDescription>
        </Alert>
      ) : null}

      <Alert variant="info">
        <KeyRound className="size-4" />
        <AlertTitle>{t('keysAdmin.procedureTitle')}</AlertTitle>
        <AlertDescription>
          <p>{t('keysAdmin.procedureIntro')}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            {PROCEDURE_STEPS.map((step) => (
              <li key={step}>{t(`keysAdmin.procedure.${step}`)}</li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            {data.scheduler.enabled
              ? t('keysAdmin.scheduler').replace('{minutes}', String(data.scheduler.intervalMinutes))
              : t('keysAdmin.schedulerOff')}{' '}
            · {t('keysAdmin.procedureDoc')}
          </p>
        </AlertDescription>
      </Alert>

      {!canRotate ? <p className="text-sm text-muted-foreground">{t('keysAdmin.upToDate')}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {data.purposes.map((status) => (
          <KeysPurposeCard key={status.purpose} status={status} t={t} locale={locale} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('keysAdmin.lastRun')}</CardTitle>
          {data.lastRun ? (
            <CardDescription className="flex flex-wrap items-center gap-2">
              <StatusBadge status={data.lastRun.status} />
              <span>{formatDate(data.lastRun.startedAt, locale, true)}</span>
              <span>·</span>
              <span>
                {t('keysAdmin.triggeredBy')} <span className="font-mono">{data.lastRun.triggeredBy}</span>
              </span>
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          {!data.lastRun ? (
            <EmptyState title={t('keysAdmin.never')} />
          ) : data.lastRun.error ? (
            <p className="text-sm text-destructive">
              {t('keysAdmin.error')} : {data.lastRun.error}
            </p>
          ) : (
            <KeysRunTable run={data.lastRun} t={t} locale={locale} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
