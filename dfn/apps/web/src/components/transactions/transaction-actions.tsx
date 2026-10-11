'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Ban, CheckCircle2, FlaskConical, Landmark, RotateCcw, Scale, Send } from 'lucide-react';
import { DisputeReason } from '@dfn/shared';
import { Button, Label, Select, Textarea } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from './action-dialog';
import { UploadDocumentDialog } from './upload-dialog';
import { FormMessage } from '@/components/form-message';

export function TransactionActions({ tx }: { tx: any }) {
  const { t } = useI18n();
  const router = useRouter();
  const actions: string[] = tx.nextActions ?? [];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [disputeReason, setDisputeReason] = useState('NOT_AS_DESCRIBED');
  const [disputeText, setDisputeText] = useState('');
  const [refundText, setRefundText] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

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
  const has = (a: string) => actions.includes(a);
  const openDispute = tx.disputes?.find((d: any) => d.status !== 'CLOSED');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {has('ACCEPT_TERMS') ? (
          <Button
            loading={busy === 'terms'}
            onClick={() =>
              run('terms', () =>
                api(`/v1/transactions/${tx.id}/accept-terms`, {
                  method: 'POST',
                  json: { contractVersionId: tx.contract.currentVersion.id, accept: true },
                }),
              )
            }
          >
            <CheckCircle2 /> {t('actions.ACCEPT_TERMS')}
          </Button>
        ) : null}
        {has('REQUEST_FUNDING') ? (
          <Button
            loading={busy === 'fund'}
            onClick={() =>
              run('fund', () =>
                api(`/v1/transactions/${tx.id}/funding/request`, {
                  method: 'POST',
                  json: { method: 'BANK_TRANSFER_SIMULATED' },
                }),
              )
            }
          >
            <Landmark /> {t('actions.REQUEST_FUNDING')}
          </Button>
        ) : null}
        {has('SIMULATE_PARTNER_CONFIRMATION') && tx.funding ? (
          <Button
            variant="accent"
            loading={busy === 'confirm'}
            onClick={() =>
              run('confirm', () =>
                api('/v1/sandbox/partner/funding-events', {
                  method: 'POST',
                  json: { fundingReference: tx.funding.reference, outcome: 'CONFIRMED' },
                }),
              )
            }
          >
            <FlaskConical /> {t('actions.SIMULATE_PARTNER_CONFIRMATION')}
          </Button>
        ) : null}
        {has('UPLOAD_DOCUMENT') ? <UploadDocumentDialog transactionId={tx.id} /> : null}
        {has('RESEND_INVITATION') ? (
          <Button
            variant="outline"
            loading={busy === 'resend'}
            onClick={() =>
              run('resend', async () => {
                const r = await api(`/v1/transactions/${tx.id}/invitation/resend`, { method: 'POST' });
                setInviteUrl(`${window.location.origin}${new URL(r.acceptUrl).pathname}`);
              })
            }
          >
            <Send /> {t('actions.RESEND_INVITATION')}
          </Button>
        ) : null}
        {has('OPEN_DISPUTE') ? (
          <ActionDialog
            trigger={
              <Button variant="outline">
                <Scale /> {t('actions.OPEN_DISPUTE')}
              </Button>
            }
            title={t('dispute.open')}
            description={t('dispute.frozen')}
            variant="destructive"
            disabled={disputeText.trim().length < 20}
            onConfirm={async () => {
              const d = await api(`/v1/transactions/${tx.id}/disputes`, {
                method: 'POST',
                json: { reason: disputeReason, description: disputeText, documentIds: [] },
              });
              router.push(`/disputes/${d.id}`);
              router.refresh();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="dispute-reason">{t('dispute.reason')}</Label>
              <Select
                id="dispute-reason"
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
              >
                {Object.values(DisputeReason).map((r) => (
                  <option key={r} value={r}>
                    {t(`dispute.reasons.${r}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dispute-text">{t('dispute.description')}</Label>
              <Textarea
                id="dispute-text"
                value={disputeText}
                onChange={(e) => setDisputeText(e.target.value)}
                minLength={20}
                required
              />
            </div>
          </ActionDialog>
        ) : null}
        {has('REQUEST_REFUND') ? (
          <ActionDialog
            trigger={
              <Button variant="outline">
                <RotateCcw /> {t('actions.REQUEST_REFUND')}
              </Button>
            }
            title={t('actions.REQUEST_REFUND')}
            description={t('dispute.frozen')}
            disabled={refundText.trim().length < 3}
            onConfirm={async () => {
              const d = await api(`/v1/transactions/${tx.id}/refund-request`, {
                method: 'POST',
                json: { reason: refundText },
              });
              router.push(`/disputes/${d.id}`);
              router.refresh();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="refund-text">{t('dispute.rationale')}</Label>
              <Textarea
                id="refund-text"
                value={refundText}
                onChange={(e) => setRefundText(e.target.value)}
                required
              />
            </div>
          </ActionDialog>
        ) : null}
        {has('VIEW_DISPUTE') && openDispute ? (
          <Button asChild variant="secondary">
            <Link href={`/disputes/${openDispute.id}`}>
              <Scale /> {t('actions.VIEW_DISPUTE')}
            </Link>
          </Button>
        ) : null}
        {has('CANCEL') ? (
          <ActionDialog
            trigger={
              <Button variant="ghost" className="text-destructive">
                <Ban /> {t('actions.CANCEL')}
              </Button>
            }
            title={t('actions.CANCEL')}
            variant="destructive"
            disabled={cancelReason.trim().length < 3}
            onConfirm={() =>
              api(`/v1/transactions/${tx.id}/cancel`, {
                method: 'POST',
                json: { reason: cancelReason },
              }).then(() => router.refresh())
            }
          >
            <div className="space-y-2">
              <Label htmlFor="cancel-reason">{t('tx.cancelReason')}</Label>
              <Textarea
                id="cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                required
              />
            </div>
          </ActionDialog>
        ) : null}
      </div>
      {inviteUrl ? (
        <p className="rounded-md border bg-muted p-3 text-xs">
          {t('tx.invitationLink')}: <code className="break-all">{inviteUrl}</code>
        </p>
      ) : null}
      <FormMessage error={error} />
    </div>
  );
}
