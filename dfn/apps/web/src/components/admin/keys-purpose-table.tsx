import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import type { Locale } from '@/lib/i18n';
import { formatDate } from '@/lib/format';
import { KeysLifecycleAction } from './keys-lifecycle-action';
import { KeysRotateButton } from './keys-rotate-button';

/** Shapes returned by GET /v1/admin/keys (key ids and counts only — never key material). */
export interface KeyUsage {
  keyId: string;
  active: boolean;
  configured: boolean;
  legacy: boolean;
  count: number;
}
export type ManagedKeyStatus = 'STAGED' | 'ACTIVE' | 'DECRYPT_ONLY' | 'RETIRED';
/** A KMS-managed data key: ids, dates and counts (the wrapped key never leaves the API). */
export interface ManagedKey {
  keyId: string;
  status: ManagedKeyStatus;
  kmsProvider: string;
  kmsKeyRef: string;
  createdAt: string;
  createdByUserId: string | null;
  activateAfter: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  retiredAt: string | null;
  loaded: boolean;
  count: number;
  deletedBlobs: number;
  retireBlocker: { reason: string; details: Record<string, any> } | null;
  nextActions: string[];
}
export interface PurposeStatus {
  purpose: string;
  sources: string[];
  activeKeyId: string;
  configuredKeyIds: string[];
  keys: KeyUsage[];
  total: number;
  pendingRotation: number;
  unreadable: number;
  batchSize: number;
  managedKeys: ManagedKey[];
  legacy: { values: number; deletedBlobs: number };
  nextActions: string[];
}
export interface PurposeRunSummary {
  activeKeyId: string;
  scanned: number;
  rotated: number;
  failed: number;
  remaining: number;
  repaired?: number;
  errors?: Record<string, number>;
}
export interface KeysRun {
  id: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: {
    purpose?: string;
    scanned?: number;
    rotated?: number;
    failed?: number;
    remaining?: number;
    purposes?: Record<string, PurposeRunSummary>;
  } | null;
  error: string | null;
}
export interface KeysStatus {
  sandbox: boolean;
  storage: { activeDriver: string; documentsByDriver: Array<{ driver: string; count: number }> };
  scheduler: { enabled: boolean; intervalMinutes: number };
  purposes: PurposeStatus[];
  totals: { values: number; pendingRotation: number; unreadable: number };
  lastRun: KeysRun | null;
  kms: {
    provider: 'none' | 'local' | 'aws';
    keyRef: string | null;
    activationDelaySeconds: number;
    refreshSeconds: number;
    rotationIntervalDays: number;
    lastRefreshAt: string | null;
    refreshError: string | null;
    loadFailures: Array<{ purpose: string; keyId: string; status: string; reason: string }>;
  };
  legacy: { decryptEnabled: boolean; values: number; deletedBlobs: number; safeToDisable: boolean };
  recoveryCodes: {
    secret: 'MFA_RECOVERY_SECRET' | 'SESSION_SECRET';
    sessionSecretBound: number;
    /** Unused codes created under an MFA_RECOVERY_SECRET that is no longer set (rejected). */
    orphanedV2: number;
  };
  nextActions: string[];
}

type T = (path: string) => string;

/** Deterministic integer formatting (no Intl): thin spaces in French, commas in English. */
export function formatCount(n: number, locale: Locale): string {
  const grouped = String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'fr' ? ' ' : ',');
  return grouped;
}

function KeyStateBadge({ usage, t }: { usage: KeyUsage; t: T }) {
  if (!usage.configured) return <Badge variant="destructive">{t('keysAdmin.states.missing')}</Badge>;
  if (usage.active) return <Badge variant="success">{t('keysAdmin.states.active')}</Badge>;
  if (usage.legacy) return <Badge variant="muted">{t('keysAdmin.states.legacy')}</Badge>;
  return <Badge variant="secondary">{t('keysAdmin.states.decryptOnly')}</Badge>;
}

const MANAGED_BADGE: Record<ManagedKeyStatus, 'warning' | 'success' | 'secondary' | 'muted'> = {
  STAGED: 'warning',
  ACTIVE: 'success',
  DECRYPT_ONLY: 'secondary',
  RETIRED: 'muted',
};

/** Why RETIRE is not offered yet, in words (reasons from the API's retire guard). */
function blockerText(key: ManagedKey, t: T, locale: Locale): string | null {
  const blocker = key.retireBlocker;
  if (!blocker) return null;
  const text = t(`keysAdmin.lifecycle.blockers.${blocker.reason}`);
  if (text === `keysAdmin.lifecycle.blockers.${blocker.reason}`) return blocker.reason;
  const refs = blocker.details.references ?? {};
  return text
    .replace('{date}', formatDate(blocker.details.retireAfter, locale, true))
    .replace('{values}', formatCount(Number(refs.values ?? 0), locale))
    .replace('{pending}', formatCount(Number(refs.pendingDocuments ?? 0), locale));
}

/** KMS-managed keys of a purpose: status, lifecycle dates, KMS reference, usage and RETIRE. */
export function ManagedKeysTable({ status, t, locale }: { status: PurposeStatus; t: T; locale: Locale }) {
  if (status.managedKeys.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('keysAdmin.managed.empty')}</p>;
  }
  const date = (label: string, value: string | null) =>
    value ? (
      <li>
        {label} : {formatDate(value, locale, true)}
      </li>
    ) : null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('keysAdmin.managed.keyId')}</TableHead>
          <TableHead>{t('keysAdmin.managed.status')}</TableHead>
          <TableHead>{t('keysAdmin.managed.dates')}</TableHead>
          <TableHead>{t('keysAdmin.managed.kms')}</TableHead>
          <TableHead className="text-right">{t('keysAdmin.managed.values')}</TableHead>
          <TableHead>{t('keysAdmin.managed.action')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {status.managedKeys.map((key) => (
          <TableRow key={key.keyId}>
            <TableCell>
              <p className="font-mono text-xs">{key.keyId}</p>
              {key.status !== 'RETIRED' ? (
                <p className={`text-[11px] ${key.loaded ? 'text-muted-foreground' : 'text-destructive'}`}>
                  {key.loaded ? t('keysAdmin.managed.loaded') : t('keysAdmin.managed.notLoaded')}
                </p>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge variant={MANAGED_BADGE[key.status]}>
                {t(`keysAdmin.managed.statuses.${key.status}`)}
              </Badge>
            </TableCell>
            <TableCell>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                <li>
                  {t('keysAdmin.managed.created')} : {formatDate(key.createdAt, locale, true)}
                  {key.createdByUserId ? null : ` (${t('keysAdmin.managed.scheduled')})`}
                </li>
                {key.status === 'STAGED'
                  ? date(t('keysAdmin.managed.activateAfter'), key.activateAfter)
                  : null}
                {date(t('keysAdmin.managed.activated'), key.activatedAt)}
                {date(t('keysAdmin.managed.deactivated'), key.deactivatedAt)}
                {date(t('keysAdmin.managed.retired'), key.retiredAt)}
              </ul>
            </TableCell>
            <TableCell className="text-xs">
              <p>{t(`keysAdmin.kms.providers.${key.kmsProvider}`)}</p>
              <p className="break-all font-mono text-[11px] text-muted-foreground">{key.kmsKeyRef}</p>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCount(key.count, locale)}
              {key.deletedBlobs > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {t('keysAdmin.managed.deletedBlobs').replace('{n}', formatCount(key.deletedBlobs, locale))}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="max-w-56">
              {key.nextActions.includes('RETIRE') ? (
                <KeysLifecycleAction action="RETIRE" purpose={status.purpose} keyId={key.keyId} />
              ) : (
                <p className="text-xs text-muted-foreground">{blockerText(key, t, locale) ?? '—'}</p>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * One card per key purpose: active key, every key id with its value count, pending rotation, the
 * KMS-managed keys of the purpose and what still uses the legacy key.
 */
export function KeysPurposeCard({
  status,
  t,
  locale,
  kmsEnabled,
}: {
  status: PurposeStatus;
  t: T;
  locale: Locale;
  /** A KMS is configured (KMS_PROVIDER ≠ none). */
  kmsEnabled: boolean;
}) {
  const canRotate = status.nextActions.includes('ROTATE');
  // Managed keys may exist from an earlier configuration: always list them when there are some.
  const showManaged = kmsEnabled || status.managedKeys.length > 0;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t(`keysAdmin.purposes.${status.purpose}`)}
            <span className="font-mono text-xs font-normal text-muted-foreground">{status.purpose}</span>
          </CardTitle>
          <CardDescription>{t(`keysAdmin.purposeDescriptions.${status.purpose}`)}</CardDescription>
          <p className="text-xs text-muted-foreground">
            {t('keysAdmin.activeKey')} :{' '}
            <span className="font-mono text-foreground">{status.activeKeyId}</span> · {t('keysAdmin.sources')}{' '}
            : <span className="font-mono">{status.sources.join(', ')}</span> · {t('keysAdmin.batch')} :{' '}
            {formatCount(status.batchSize, locale)}
          </p>
          {status.legacy.values > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('keysAdmin.legacyKey.perPurpose').replace('{n}', formatCount(status.legacy.values, locale))}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          {status.pendingRotation > 0 ? (
            <Badge variant="warning">
              {t('keysAdmin.pending')} : {formatCount(status.pendingRotation, locale)}
            </Badge>
          ) : (
            <Badge variant="success">{t('keysAdmin.upToDateShort')}</Badge>
          )}
          {canRotate ? (
            <KeysRotateButton
              purpose={status.purpose}
              label={t('keysAdmin.rotatePurpose')}
              variant="outline"
            />
          ) : null}
          {status.nextActions.includes('GENERATE') ? (
            <KeysLifecycleAction action="GENERATE" purpose={status.purpose} />
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('keysAdmin.keyId')}</TableHead>
              <TableHead>{t('keysAdmin.state')}</TableHead>
              <TableHead className="text-right">{t('keysAdmin.count')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {status.keys.map((usage) => (
              <TableRow key={usage.keyId}>
                <TableCell className="font-mono text-sm">{usage.keyId}</TableCell>
                <TableCell>
                  <KeyStateBadge usage={usage} t={t} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(usage.count, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {showManaged ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t('keysAdmin.managed.title')}</h4>
            <ManagedKeysTable status={status} t={t} locale={locale} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Per-purpose counters of the last ENCRYPTION_KEY_ROTATION run. */
export function KeysRunTable({ run, t, locale }: { run: KeysRun; t: T; locale: Locale }) {
  const rows = Object.entries(run.summary?.purposes ?? {});
  if (rows.length === 0) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('keysAdmin.purposeColumn')}</TableHead>
          <TableHead>{t('keysAdmin.activeKey')}</TableHead>
          <TableHead className="text-right">{t('keysAdmin.scanned')}</TableHead>
          <TableHead className="text-right">{t('keysAdmin.rotated')}</TableHead>
          <TableHead className="text-right">{t('keysAdmin.failed')}</TableHead>
          <TableHead className="text-right">{t('keysAdmin.remaining')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([purpose, s]) => (
          <TableRow key={purpose}>
            <TableCell>
              {t(`keysAdmin.purposes.${purpose}`)}
              {s.repaired ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({t('keysAdmin.repaired')} : {formatCount(s.repaired, locale)})
                </span>
              ) : null}
              {s.errors ? (
                <p className="font-mono text-[11px] text-destructive">
                  {Object.entries(s.errors)
                    .map(([reason, count]) => `${reason}×${count}`)
                    .join(' · ')}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="font-mono text-xs">{s.activeKeyId}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(s.scanned, locale)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(s.rotated, locale)}</TableCell>
            <TableCell className={`text-right tabular-nums ${s.failed > 0 ? 'text-destructive' : ''}`}>
              {formatCount(s.failed, locale)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(s.remaining, locale)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
