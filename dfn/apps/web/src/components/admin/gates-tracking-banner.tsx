import { ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@dfn/ui';

type T = (path: string) => string;

/** Prominent "tracking only" notice shown on every regulatory gates screen. */
export function GatesTrackingBanner({ t, canManage }: { t: T; canManage: boolean }) {
  return (
    <Alert variant="warning">
      <ShieldAlert className="size-4" />
      <AlertTitle>{t('gatesAdmin.bannerTitle')}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p className="font-medium">{t('gatesAdmin.banner')}</p>
        <p>{t('gatesAdmin.bannerDetail')}</p>
        <p className="text-xs text-muted-foreground">
          {canManage ? t('gatesAdmin.fourEyes') : t('gatesAdmin.readOnly')}
        </p>
      </AlertDescription>
    </Alert>
  );
}
