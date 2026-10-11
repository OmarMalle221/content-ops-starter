'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

interface RotationRun {
  status: string;
  error: string | null;
  summary: { rotated?: number; failed?: number; remaining?: number } | null;
}

/**
 * Runs ENCRYPTION_KEY_ROTATION now through POST /v1/admin/keys/rotate (one purpose or all),
 * then refreshes the server-rendered counts. Only rendered when the API offers the ROTATE action.
 */
export function KeysRotateButton({
  purpose,
  label,
  variant = 'default',
}: {
  purpose?: string;
  label: string;
  variant?: 'default' | 'outline';
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [result, setResult] = useState<RotationRun | null>(null);
  const purposeLabel = purpose ? t(`keysAdmin.purposes.${purpose}`) : t('keysAdmin.allPurposes');
  return (
    <div className="space-y-1">
      <ActionDialog
        trigger={
          <Button size="sm" variant={variant}>
            <RefreshCw /> {label}
          </Button>
        }
        title={`${t('keysAdmin.rotate')} — ${purposeLabel}`}
        description={t('keysAdmin.rotateConfirm')}
        confirmLabel={t('keysAdmin.rotate')}
        onConfirm={async () => {
          const run = await api<RotationRun>('/v1/admin/keys/rotate', {
            method: 'POST',
            json: purpose ? { purpose } : {},
          });
          setResult(run);
          router.refresh();
        }}
      />
      {result ? (
        <p
          className={`max-w-xs text-xs ${result.status === 'COMPLETED' ? 'text-success' : 'text-destructive'}`}
          role="status"
        >
          {result.status === 'COMPLETED'
            ? `${t('keysAdmin.lastResult')} : ${t('keysAdmin.rotated')} ${result.summary?.rotated ?? 0} · ${t(
                'keysAdmin.failed',
              )} ${result.summary?.failed ?? 0} · ${t('keysAdmin.remaining')} ${result.summary?.remaining ?? 0}`
            : `${t('keysAdmin.error')} : ${result.error ?? result.status}`}
        </p>
      ) : null}
    </div>
  );
}
