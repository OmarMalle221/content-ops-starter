'use client';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { DocumentScanStatus, SANDBOX_SCAN_ENGINE, type DocumentScanDto } from '@dfn/shared';
import { Badge } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

const VARIANT = {
  CLEAN: 'success',
  INFECTED: 'destructive',
  SKIPPED: 'warning',
  NOT_SCANNED: 'muted',
} as const satisfies Record<DocumentScanStatus, string>;

const ICON = { CLEAN: ShieldCheck, INFECTED: ShieldAlert, SKIPPED: ShieldOff, NOT_SCANNED: Shield };

/**
 * Antivirus verdict of a document. A verdict of the sandbox engine is labelled as a simulation
 * (it only recognises the EICAR test file); the explanation is the tooltip, also read by screen
 * readers.
 */
export function ScanBadge({ scan }: { scan?: DocumentScanDto | null }) {
  const { t } = useI18n();
  const status: DocumentScanStatus =
    scan && scan.status in VARIANT ? scan.status : DocumentScanStatus.NOT_SCANNED;
  const simulated = scan?.engine === SANDBOX_SCAN_ENGINE;
  let hint: string | null = null;
  if (simulated) hint = t('documentStorage.scan.hint.sandbox');
  else if (status === DocumentScanStatus.CLEAN)
    hint = scan?.engine === 'clamd' ? t('documentStorage.scan.hint.clamd') : null;
  else hint = t(`documentStorage.scan.hint.${status}`);
  if (status === DocumentScanStatus.INFECTED && simulated) {
    hint = `${t('documentStorage.scan.hint.INFECTED')} ${hint}`;
  }
  const Icon = ICON[status];
  return (
    <Badge variant={VARIANT[status]} title={hint ?? undefined} className="gap-1 whitespace-nowrap">
      <Icon className="size-3" aria-hidden />
      {t(`documentStorage.scan.${status}`)}
      {simulated ? ` · ${t('documentStorage.scan.simulated')}` : null}
      {hint ? <span className="sr-only"> — {hint}</span> : null}
    </Badge>
  );
}
