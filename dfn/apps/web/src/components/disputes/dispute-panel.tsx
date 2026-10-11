'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Gavel, Send } from 'lucide-react';
import { DisputeOutcome } from '@dfn/shared';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { ActionDialog } from '@/components/transactions/action-dialog';

export function DisputePanel({
  dispute,
  staff,
  isParty,
}: {
  dispute: any;
  staff: boolean;
  isParty: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState({
    outcome: 'RELEASE_TO_SELLER',
    rationale: '',
    sellerAmount: '',
    buyerAmount: '',
    isFinal: false,
  });
  const [appeal, setAppeal] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const open = dispute.status !== 'CLOSED';

  async function send() {
    setLoading(true);
    setError(null);
    try {
      await api(`/v1/disputes/${dispute.id}/messages`, { method: 'POST', json: { body: message, internal } });
      setMessage('');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {open ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('dispute.newMessage')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              {staff ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />{' '}
                  Note interne / internal note
                </label>
              ) : (
                <span />
              )}
              <Button onClick={send} loading={loading} disabled={!message.trim()}>
                <Send /> {t('common.send')}
              </Button>
            </div>
            <FormMessage error={error} />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {isParty && dispute.status === 'DECIDED' ? (
          <ActionDialog
            trigger={<Button variant="outline">{t('dispute.appeal')}</Button>}
            title={t('dispute.appeal')}
            disabled={appeal.trim().length < 20}
            onConfirm={() =>
              api(`/v1/disputes/${dispute.id}/appeal`, { method: 'POST', json: { grounds: appeal } }).then(
                () => router.refresh(),
              )
            }
          >
            <div className="space-y-2">
              <Label htmlFor="appeal">{t('dispute.appealGrounds')}</Label>
              <Textarea id="appeal" value={appeal} onChange={(e) => setAppeal(e.target.value)} />
            </div>
          </ActionDialog>
        ) : null}
        {staff && dispute.status === 'OPEN' ? (
          <Button
            onClick={() =>
              api(`/v1/disputes/${dispute.id}/review`, { method: 'POST' })
                .then(() => router.refresh())
                .catch((e) => setError(errorMessage(e)))
            }
          >
            {t('dispute.review')}
          </Button>
        ) : null}
        {staff && ['UNDER_REVIEW', 'APPEALED'].includes(dispute.status) ? (
          <ActionDialog
            trigger={
              <Button variant="accent">
                <Gavel /> {t('dispute.decide')}
              </Button>
            }
            title={t('dispute.decide')}
            description={t('app.sandbox')}
            disabled={
              decision.rationale.trim().length < 20 ||
              (decision.outcome === 'SPLIT' && (!decision.sellerAmount || !decision.buyerAmount))
            }
            onConfirm={() =>
              api(`/v1/disputes/${dispute.id}/decide`, {
                method: 'POST',
                json: {
                  outcome: decision.outcome,
                  rationale: decision.rationale,
                  isFinal: decision.isFinal || dispute.status === 'APPEALED',
                  ...(decision.outcome === 'SPLIT'
                    ? { sellerAmount: decision.sellerAmount, buyerAmount: decision.buyerAmount }
                    : {}),
                },
              }).then(() => router.refresh())
            }
          >
            <div className="space-y-2">
              <Label htmlFor="outcome">{t('dispute.outcome')}</Label>
              <Select
                id="outcome"
                value={decision.outcome}
                onChange={(e) => setDecision((d) => ({ ...d, outcome: e.target.value }))}
              >
                {Object.values(DisputeOutcome).map((o) => (
                  <option key={o} value={o}>
                    {t(`dispute.outcomes.${o}`)}
                  </option>
                ))}
              </Select>
            </div>
            {decision.outcome === 'SPLIT' ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label htmlFor="sellerAmount">{t('dispute.sellerAmount')}</Label>
                  <Input
                    id="sellerAmount"
                    inputMode="decimal"
                    value={decision.sellerAmount}
                    onChange={(e) => setDecision((d) => ({ ...d, sellerAmount: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="buyerAmount">{t('dispute.buyerAmount')}</Label>
                  <Input
                    id="buyerAmount"
                    inputMode="decimal"
                    value={decision.buyerAmount}
                    onChange={(e) => setDecision((d) => ({ ...d, buyerAmount: e.target.value }))}
                  />
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="rationale">{t('dispute.rationale')}</Label>
              <Textarea
                id="rationale"
                value={decision.rationale}
                onChange={(e) => setDecision((d) => ({ ...d, rationale: e.target.value }))}
              />
            </div>
            {dispute.status !== 'APPEALED' ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={decision.isFinal}
                  onChange={(e) => setDecision((d) => ({ ...d, isFinal: e.target.checked }))}
                />{' '}
                {t('dispute.final')}
              </label>
            ) : null}
          </ActionDialog>
        ) : null}
        {staff && dispute.status === 'DECIDED' ? (
          <ActionDialog
            trigger={<Button variant="outline">{t('dispute.close')}</Button>}
            title={t('dispute.close')}
            disabled={closeNote.trim().length < 3}
            onConfirm={() =>
              api(`/v1/disputes/${dispute.id}/close`, { method: 'POST', json: { note: closeNote } }).then(
                () => router.refresh(),
              )
            }
          >
            <div className="space-y-2">
              <Label htmlFor="closeNote">{t('tx.note')}</Label>
              <Textarea id="closeNote" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
            </div>
          </ActionDialog>
        ) : null}
      </div>
      <FormMessage error={error} />
    </div>
  );
}
