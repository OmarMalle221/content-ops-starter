'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Ban, FileText, FlaskConical, Scale, XCircle } from 'lucide-react';
import { Button, Label, Textarea } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { FormMessage } from '@/components/form-message';
import { AuthorizeTransferDialog } from './authorize-dialog';
import type { TransferDto } from './types';

/** Every control is derived from `nextActions` computed server-side; nothing decorative. */
export function TransferActions({ transfer, mfaEnabled }: { transfer: TransferDto; mfaEnabled: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const actions = transfer.nextActions ?? [];
  const has = (a: string) => actions.includes(a);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [failureReason, setFailureReason] = useState('');

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const partnerEvent = (outcome: 'SETTLED' | 'FAILED', reason?: string) =>
    api('/v1/sandbox/partner/transfer-events', {
      method: 'POST',
      json: { transferReference: transfer.reference, outcome, ...(reason ? { failureReason: reason } : {}) },
    });

  if (actions.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {has('AUTHORIZE') ? (
          <AuthorizeTransferDialog
            transfer={transfer}
            mfaEnabled={mfaEnabled}
            onDone={() => router.refresh()}
          />
        ) : null}
        {has('SIMULATE_PARTNER_SETTLEMENT') ? (
          <Button
            variant="accent"
            loading={busy === 'settle'}
            onClick={() => run('settle', () => partnerEvent('SETTLED'))}
          >
            <FlaskConical /> {t('xfer.simulateSettlement')}
          </Button>
        ) : null}
        {has('SIMULATE_PARTNER_FAILURE') ? (
          <ActionDialog
            trigger={
              <Button variant="outline">
                <XCircle /> {t('xfer.simulateFailure')}
              </Button>
            }
            title={t('xfer.simulateFailureTitle')}
            description={t('xfer.simulateFailureDescription')}
            variant="destructive"
            onConfirm={async () => {
              try {
                await partnerEvent('FAILED', failureReason.trim() || undefined);
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              setFailureReason('');
              router.refresh();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="transfer-failure-reason">{t('xfer.failureReason')}</Label>
              <Textarea
                id="transfer-failure-reason"
                value={failureReason}
                maxLength={300}
                onChange={(e) => setFailureReason(e.target.value)}
              />
            </div>
          </ActionDialog>
        ) : null}
        {has('VIEW_RECEIPT') ? (
          <>
            <Button asChild variant="outline">
              <a href={`/api/v1/transfers/${transfer.id}/receipt?format=txt`}>
                <FileText /> {t('xfer.receiptTxt')}
              </a>
            </Button>
            <Button asChild variant="ghost">
              <a href={`/api/v1/transfers/${transfer.id}/receipt`} target="_blank" rel="noreferrer">
                {t('xfer.receiptJson')}
              </a>
            </Button>
          </>
        ) : null}
        {has('REVIEW') ? (
          <Button asChild variant="secondary">
            <Link href="/admin/transfers">
              <Scale /> {t('xfer.review')}
            </Link>
          </Button>
        ) : null}
        {has('CANCEL') ? (
          <ActionDialog
            trigger={
              <Button variant="ghost" className="text-destructive">
                <Ban /> {t('xfer.cancel')}
              </Button>
            }
            title={t('xfer.cancelTitle')}
            variant="destructive"
            disabled={cancelReason.trim().length < 3}
            onConfirm={async () => {
              try {
                await api(`/v1/transfers/${transfer.id}/cancel`, {
                  method: 'POST',
                  json: { reason: cancelReason },
                });
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              setCancelReason('');
              router.refresh();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="transfer-cancel-reason">{t('xfer.cancelReason')}</Label>
              <Textarea
                id="transfer-cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                required
              />
            </div>
          </ActionDialog>
        ) : null}
      </div>
      <FormMessage error={error} />
    </div>
  );
}
