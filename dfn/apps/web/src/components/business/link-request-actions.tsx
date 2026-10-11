'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Button, Label, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

/** Target-side decision on a counterparty link request (server `nextActions`: ACCEPT / DECLINE). */
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
  const decide = (decision: 'accept' | 'decline') => async () => {
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
    </div>
  );
}
