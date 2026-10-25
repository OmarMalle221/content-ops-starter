'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Label, Textarea } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

/** Compliance decision on a REVIEW_REQUIRED transfer: approve (executes the debit) or reject. */
export function TransferReviewButtons({ transferId }: { transferId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [note, setNote] = useState('');
  return (
    <div className="flex gap-2">
      {(['APPROVE', 'REJECT'] as const).map((decision) => (
        <ActionDialog
          key={decision}
          trigger={
            <Button size="sm" variant={decision === 'APPROVE' ? 'success' : 'destructive'}>
              {decision === 'APPROVE' ? t('xferAdmin.approve') : t('xferAdmin.reject')}
            </Button>
          }
          title={decision === 'APPROVE' ? t('xferAdmin.approveTitle') : t('xferAdmin.rejectTitle')}
          description={
            decision === 'APPROVE' ? t('xferAdmin.approveDescription') : t('xferAdmin.rejectDescription')
          }
          confirmLabel={decision === 'APPROVE' ? t('xferAdmin.approve') : t('xferAdmin.reject')}
          variant={decision === 'APPROVE' ? 'success' : 'destructive'}
          disabled={note.trim().length < 3}
          onConfirm={async () => {
            try {
              await api(`/v1/admin/transfers/${transferId}/review`, {
                method: 'POST',
                json: { decision, note: note.trim() },
              });
            } catch (e) {
              throw new Error(errorMessage(e));
            }
            setNote('');
            router.refresh();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`review-note-${decision}-${transferId}`}>{t('xferAdmin.note')}</Label>
            <Textarea
              id={`review-note-${decision}-${transferId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              minLength={3}
              required
              aria-describedby={`review-note-hint-${decision}-${transferId}`}
            />
            {/* The note reaches the customer (AML_POLICY: measures are notified with the reason). */}
            <p id={`review-note-hint-${decision}-${transferId}`} className="text-xs text-muted-foreground">
              {t('xferAdmin.noteVisibleHint')}
            </p>
          </div>
        </ActionDialog>
      ))}
    </div>
  );
}
