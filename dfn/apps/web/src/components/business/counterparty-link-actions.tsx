'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Unlink } from 'lucide-react';
import { Button, Label, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

/**
 * Requester-side link controls of a client record, driven by the server `link.nextActions`:
 * REVOKE_LINK (withdraw a request / end a link) and REQUEST_LINK (send it again after the cooldown).
 */
export function CounterpartyLinkActions({
  organizationId,
  counterpartyId,
  nextActions,
}: {
  organizationId: string;
  counterpartyId: string;
  nextActions: string[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const base = `/v1/organizations/${organizationId}/counterparties/${counterpartyId}/link`;
  if (nextActions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {nextActions.includes('REVOKE_LINK') ? (
        <ActionDialog
          trigger={
            <Button size="sm" variant="outline">
              <Unlink /> {t('counterpartyLinks.revoke')}
            </Button>
          }
          title={t('counterpartyLinks.revokeTitle')}
          description={t('counterpartyLinks.revokeHint')}
          variant="destructive"
          confirmLabel={t('counterpartyLinks.revoke')}
          onConfirm={async () => {
            await api(`${base}/revoke`, {
              method: 'POST',
              json: { reason: reason.trim() || undefined },
            });
            setReason('');
            router.refresh();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`revoke-${counterpartyId}`}>{t('counterpartyLinks.reason')}</Label>
            <Textarea
              id={`revoke-${counterpartyId}`}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </ActionDialog>
      ) : null}
      {nextActions.includes('REQUEST_LINK') ? (
        <ActionDialog
          trigger={
            <Button size="sm" variant="outline">
              <Link2 /> {t('counterpartyLinks.requestAgain')}
            </Button>
          }
          title={t('counterpartyLinks.requestAgain')}
          description={t('counterpartyLinks.requestAgainHint')}
          confirmLabel={t('counterpartyLinks.requestAgain')}
          onConfirm={async () => {
            await api(`${base}/request`, { method: 'POST', json: {} });
            router.refresh();
          }}
        >
          <p className="text-sm text-muted-foreground">{t('counterpartyLinks.consentHint')}</p>
        </ActionDialog>
      ) : null}
    </div>
  );
}
