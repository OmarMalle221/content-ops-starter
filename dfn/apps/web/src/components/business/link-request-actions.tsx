'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Unlink, X } from 'lucide-react';
import { Button, Label, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

/**
 * Target-side decision on a counterparty link (server `nextActions`): ACCEPT / DECLINE a pending
 * request, REVOKE an accepted link (consent withdrawn).
 */
export function LinkRequestActions({
  organizationId,
  counterpartyId,
  requesterName,
  nextActions,
}: {
  organizationId: string;
  counterpartyId: string;
  requesterName: string;
  nextActions: string[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [note, setNote] = useState('');
  const base = `/v1/organizations/${organizationId}/link-requests/${counterpartyId}`;
  const decide = (decision: 'accept' | 'decline' | 'revoke') => async () => {
    await api(`${base}/${decision}`, { method: 'POST', json: { note: note.trim() || undefined } });
    setNote('');
    router.refresh();
  };
  const noteField = (
    <div className="space-y-1">
      <Label htmlFor={`link-note-${counterpartyId}`}>{t('counterpartyLinks.note')}</Label>
      <Textarea
        id={`link-note-${counterpartyId}`}
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </div>
  );
  if (nextActions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {nextActions.includes('ACCEPT') ? (
        <ActionDialog
          trigger={
            <Button size="sm" variant="success">
              <Check /> {t('counterpartyLinks.accept')}
            </Button>
          }
          title={`${t('counterpartyLinks.accept')} — ${requesterName}`}
          description={t('counterpartyLinks.acceptHint')}
          variant="success"
          confirmLabel={t('counterpartyLinks.accept')}
          onConfirm={decide('accept')}
        >
          {noteField}
          <p className="text-xs text-muted-foreground">{t('app.sandbox')}</p>
        </ActionDialog>
      ) : null}
      {nextActions.includes('DECLINE') ? (
        <ActionDialog
          trigger={
            <Button size="sm" variant="outline">
              <X /> {t('counterpartyLinks.decline')}
            </Button>
          }
          title={`${t('counterpartyLinks.decline')} — ${requesterName}`}
          description={t('counterpartyLinks.declineHint')}
          variant="destructive"
          confirmLabel={t('counterpartyLinks.decline')}
          onConfirm={decide('decline')}
        >
          {noteField}
        </ActionDialog>
      ) : null}
      {nextActions.includes('REVOKE') ? (
        <ActionDialog
          trigger={
            <Button size="sm" variant="outline">
              <Unlink /> {t('counterpartyLinks.endLink')}
            </Button>
          }
          title={`${t('counterpartyLinks.endLink')} — ${requesterName}`}
          description={t('counterpartyLinks.endLinkHint')}
          variant="destructive"
          confirmLabel={t('counterpartyLinks.endLink')}
          onConfirm={decide('revoke')}
        >
          {noteField}
        </ActionDialog>
      ) : null}
    </div>
  );
}
