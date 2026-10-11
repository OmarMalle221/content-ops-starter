'use client';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import { Button } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import type { WebhookDelivery } from './types';

export function DeliveryRetryButton({
  webhookId,
  delivery,
}: {
  webhookId: string;
  delivery: WebhookDelivery;
}) {
  const { t } = useI18n();
  const router = useRouter();
  if (!delivery.nextActions.includes('RETRY')) return null;
  return (
    <ActionDialog
      trigger={
        <Button variant="outline" size="sm">
          <RotateCcw /> {t('webhooks.retry')}
        </Button>
      }
      title={t('webhooks.retryTitle')}
      description={t('webhooks.retryDescription')}
      confirmLabel={t('webhooks.retry')}
      onConfirm={async () => {
        try {
          await api(`/v1/webhooks/${webhookId}/deliveries/${delivery.id}/retry`, { method: 'POST' });
        } catch (e) {
          throw new Error(errorMessage(e));
        }
        router.refresh();
      }}
    >
      <p className="font-mono text-xs text-muted-foreground">
        {delivery.eventType} · {delivery.id}
      </p>
    </ActionDialog>
  );
}
