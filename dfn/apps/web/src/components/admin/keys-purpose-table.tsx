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
import { KeysRotateButton } from './keys-rotate-button';

/** Shapes returned by GET /v1/admin/keys (key ids and counts only — never key material). */
export interface KeyUsage {
  keyId: string;
  active: boolean;
  configured: boolean;
  legacy: boolean;
  count: number;
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

/** One card per key purpose: active key, every key id with its value count, pending rotation. */
export function KeysPurposeCard({ status, t, locale }: { status: PurposeStatus; t: T; locale: Locale }) {
  const canRotate = status.nextActions.includes('ROTATE');
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
        </div>
      </CardHeader>
      <CardContent>
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
