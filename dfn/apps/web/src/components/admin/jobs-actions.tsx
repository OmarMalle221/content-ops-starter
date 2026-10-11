'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';
import { Button } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { summaryPreview } from './jobs-summary';

export function RunJobButton({
  name,
  label,
  registered,
}: {
  name: string;
  label: string;
  registered: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [result, setResult] = useState<{ status: string; summary?: unknown; error?: string | null } | null>(
    null,
  );
  if (!registered) {
    return <span className="text-xs text-muted-foreground">{t('jobsAdmin.notRegistered')}</span>;
  }
  return (
    <div className="space-y-1">
      <ActionDialog
        trigger={
          <Button size="sm" variant="outline">
            <Play /> {t('jobsAdmin.runNow')}
          </Button>
        }
        title={`${t('jobsAdmin.runNow')} — ${label}`}
        description={t('jobsAdmin.runConfirm')}
        confirmLabel={t('jobsAdmin.runNow')}
        onConfirm={async () => {
          const run = await api(`/v1/admin/jobs/${name}/run`, { method: 'POST' });
          setResult(run);
          router.refresh();
        }}
      />
      {result ? (
        <p
          className={`max-w-xs text-xs ${result.status === 'COMPLETED' ? 'text-success' : 'text-destructive'}`}
        >
          {result.status === 'COMPLETED'
            ? `${t('jobsAdmin.lastResult')}: ${summaryPreview(result.summary)}`
            : `${t('jobsAdmin.error')}: ${result.error ?? result.status}`}
        </p>
      ) : null}
    </div>
  );
}
