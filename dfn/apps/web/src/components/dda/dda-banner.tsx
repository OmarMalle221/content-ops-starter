'use client';
import { FlaskConical, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Badge } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

/**
 * Mandatory on every DDA surface: the research simulation banner. Keeps the red lines visible —
 * fictitious units, no real issuance, parity 1 DDA = 1 USD is a hypothesis under study.
 */
export function DdaBanner({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Alert variant="warning" role="status">
      <ShieldAlert className="size-4" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <span>{t('ddaLab.banner')}</span>
        <Badge variant="sandbox">
          <FlaskConical className="mr-1 size-3" aria-hidden /> {t('app.sandbox')}
        </Badge>
        <Badge variant="warning">
          {t('ddaLab.parity')} — {t('ddaLab.hypothesis')}
        </Badge>
      </AlertTitle>
      {!compact ? <AlertDescription>{t('ddaLab.bannerDetail')}</AlertDescription> : null}
    </Alert>
  );
}
