import { notFound } from 'next/navigation';
import { HardDrive, History, KeyRound, LockKeyhole, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
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
const MANAGED_STEPS = ['step1', 'step2', 'step3', 'step4'] as const;

/**
 * Key ring console — platform ADMIN only. COMPLIANCE staff can reach /admin but this surface does
 * not exist for them (404, never 403). Shows key ids and value counts only: key material never
 * leaves the API. Phase 7: KMS-managed keys (generate / retire with a fresh second factor, offered
 * by the API through `nextActions`), legacy-key retirement checklist and recovery-code secret.
 */
export default async function AdminKeysPage() {
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  if (!session || session.user.globalRole !== 'ADMIN') notFound();
  const data = await apiFetch<KeysStatus>('/v1/admin/keys');
  const canRotate = data.nextActions.includes('ROTATE');
  const kms = data.kms;
  const kmsEnabled = kms.provider !== 'none';
  const seconds = (n: number) => t('keysAdmin.kms.seconds').replace('{n}', formatCount(n, locale));
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

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <LockKeyhole className="size-4" /> {t('keysAdmin.kms.title')}
              <Badge variant={kmsEnabled ? 'success' : 'muted'}>
                {t(`keysAdmin.kms.providers.${kms.provider}`)}
              </Badge>
            </CardTitle>
            <CardDescription>{t('keysAdmin.kms.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(`keysAdmin.kms.providerNotes.${kms.provider}`)}
            </p>
            {kmsEnabled ? (
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('keysAdmin.kms.keyRef')}</dt>
                  <dd className="break-all font-mono text-xs">{kms.keyRef}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('keysAdmin.kms.lastRefresh')}</dt>
                  <dd>
                    {kms.lastRefreshAt
                      ? formatDate(kms.lastRefreshAt, locale, true)
                      : t('keysAdmin.kms.never')}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('keysAdmin.kms.activationDelay')}</dt>
                  <dd>{seconds(kms.activationDelaySeconds)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('keysAdmin.kms.refresh')}</dt>
                  <dd>{seconds(kms.refreshSeconds)}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t('keysAdmin.kms.rotationInterval')}</dt>
                  <dd>
                    {kms.rotationIntervalDays > 0
                      ? t('keysAdmin.kms.rotationEvery').replace('{days}', String(kms.rotationIntervalDays))
                      : t('keysAdmin.kms.rotationManual')}
                  </dd>
                </div>
              </dl>
            ) : null}
            {kms.loadFailures.length > 0 ? (
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertTitle>{t('keysAdmin.kms.loadFailuresTitle')}</AlertTitle>
                <AlertDescription>
                  <p>{t('keysAdmin.kms.loadFailures')}</p>
                  <ul className="mt-1 font-mono text-xs">
                    {kms.loadFailures.map((f) => (
                      <li key={`${f.purpose}:${f.keyId}`}>
                        {f.purpose}:{f.keyId} ({f.status}) — {f.reason}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {kms.refreshError ? (
              <Alert variant="warning">
                <ShieldAlert className="size-4" />
                <AlertTitle>{t('keysAdmin.kms.refreshErrorTitle')}</AlertTitle>
                <AlertDescription>{t('keysAdmin.kms.refreshError')}</AlertDescription>
              </Alert>
            ) : null}
            {kmsEnabled ? (
              <div>
                <p className="text-sm font-medium">{t('keysAdmin.kms.procedureTitle')}</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  {MANAGED_STEPS.map((step) => (
                    <li key={step}>{t(`keysAdmin.kms.procedure.${step}`)}</li>
                  ))}
                </ol>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4" /> {t('keysAdmin.legacyKey.title')}
              </CardTitle>
              <CardDescription>{t('keysAdmin.legacyKey.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Badge variant={data.legacy.decryptEnabled ? 'secondary' : 'muted'}>
                {data.legacy.decryptEnabled
                  ? t('keysAdmin.legacyKey.decryptEnabled')
                  : t('keysAdmin.legacyKey.decryptDisabled')}
              </Badge>
              <p>
                {t('keysAdmin.legacyKey.values')} :{' '}
                <span className="font-semibold tabular-nums">{formatCount(data.legacy.values, locale)}</span>
                {data.legacy.deletedBlobs > 0
                  ? ` (${t('keysAdmin.legacyKey.deletedBlobs')} : ${formatCount(data.legacy.deletedBlobs, locale)})`
                  : null}
              </p>
              {!data.legacy.decryptEnabled && data.legacy.values > 0 ? (
                <p className="text-destructive">{t('keysAdmin.legacyKey.disabledWithValues')}</p>
              ) : data.legacy.decryptEnabled ? (
                <p className={data.legacy.safeToDisable ? 'text-success' : 'text-muted-foreground'}>
                  {data.legacy.safeToDisable
                    ? t('keysAdmin.legacyKey.safe')
                    : t('keysAdmin.legacyKey.notSafe')}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4" /> {t('keysAdmin.recovery.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className={data.recoveryCodes.secret === 'MFA_RECOVERY_SECRET' ? '' : 'text-warning'}>
                {data.recoveryCodes.secret === 'MFA_RECOVERY_SECRET'
                  ? t('keysAdmin.recovery.secretMfa')
                  : t('keysAdmin.recovery.secretSession')}
              </p>
              {data.recoveryCodes.secret === 'MFA_RECOVERY_SECRET' ? (
                <p className="text-muted-foreground">
                  {t('keysAdmin.recovery.bound')} :{' '}
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatCount(data.recoveryCodes.sessionSecretBound, locale)}
                  </span>{' '}
                  — {t('keysAdmin.recovery.boundHint')}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      {!canRotate ? <p className="text-sm text-muted-foreground">{t('keysAdmin.upToDate')}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {data.purposes.map((status) => (
          <KeysPurposeCard
            key={status.purpose}
            status={status}
            t={t}
            locale={locale}
            kmsEnabled={kmsEnabled}
          />
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
