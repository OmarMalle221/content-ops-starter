'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, RefreshCw } from 'lucide-react';
import { Button } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { SecretRevealDialog } from './secret-reveal-dialog';
import type { ApiCredential } from './types';

/** Rotate / revoke buttons driven by the server-computed `nextActions` of a credential. */
export function ApiKeyActions({ credential }: { credential: ApiCredential }) {
  const { t } = useI18n();
  const router = useRouter();
  const [revealed, setRevealed] = useState<string | null>(null);
  const has = (a: string) => credential.nextActions.includes(a);
  if (!has('ROTATE') && !has('REVOKE')) return null;

  return (
    <div className="flex justify-end gap-1">
      {has('ROTATE') ? (
        <ActionDialog
          trigger={
            <Button variant="outline" size="sm">
              <RefreshCw /> {t('dev.keys.rotate')}
            </Button>
          }
          title={`${t('dev.keys.rotateTitle')} — ${credential.name}`}
          description={t('dev.keys.rotateDescription')}
          confirmLabel={t('dev.keys.rotate')}
          onConfirm={async () => {
            let rotated: { key: string; credential: ApiCredential };
            try {
              rotated = await api(`/v1/api-credentials/${credential.id}/rotate`, { method: 'POST' });
            } catch (e) {
              throw new Error(errorMessage(e));
            }
            setRevealed(rotated.key);
            router.refresh();
          }}
        >
          <p className="font-mono text-xs text-muted-foreground">{credential.keyDisplay}</p>
        </ActionDialog>
      ) : null}
      {has('REVOKE') ? (
        <ActionDialog
          trigger={
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
              <Ban /> {t('dev.keys.revoke')}
            </Button>
          }
          title={`${t('dev.keys.revokeTitle')} — ${credential.name}`}
          description={t('dev.keys.revokeDescription')}
          confirmLabel={t('dev.keys.revoke')}
          variant="destructive"
          onConfirm={async () => {
            try {
              await api(`/v1/api-credentials/${credential.id}`, { method: 'DELETE' });
            } catch (e) {
              throw new Error(errorMessage(e));
            }
            router.refresh();
          }}
        >
          <p className="font-mono text-xs text-muted-foreground">{credential.keyDisplay}</p>
        </ActionDialog>
      ) : null}
      <SecretRevealDialog
        secret={revealed}
        title={t('dev.keys.revealRotated')}
        description={t('dev.keys.revealDescription')}
        warning={t('dev.keys.revealWarning')}
        onClose={() => setRevealed(null)}
      />
    </div>
  );
}
