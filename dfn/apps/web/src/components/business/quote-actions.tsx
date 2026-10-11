'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, Check, Pencil, Send, X } from 'lucide-react';
import { Button, Input, Label, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { DocumentFormDialog, type CounterpartyOption } from './document-form';

/** Quote controls derived from the server-side `nextActions` list. */
export function QuoteActions({
  quote,
  organizationId,
  counterparties,
  defaultDueDate,
}: {
  quote: any;
  organizationId: string;
  counterparties: CounterpartyOption[];
  /** YYYY-MM-DD preset for the invoice due date when converting (computed by the server page). */
  defaultDueDate: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const actions: string[] = quote.nextActions ?? [];
  const has = (a: string) => actions.includes(a);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [dueDate, setDueDate] = useState(defaultDueDate);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {has('EDIT') ? (
          <DocumentFormDialog
            kind="QUOTE"
            organizationId={organizationId}
            counterparties={counterparties}
            initial={{
              id: quote.id,
              counterparty: quote.counterparty,
              customerName: quote.customerName,
              customerEmail: quote.customerEmail,
              currencyCode: quote.currencyCode,
              date: quote.validUntil,
              taxBps: quote.taxBps,
              notes: quote.notes,
              lines: quote.lines,
            }}
            trigger={
              <Button variant="outline">
                <Pencil /> {t('quotesX.edit')}
              </Button>
            }
          />
        ) : null}
        {has('SEND') ? (
          <ActionDialog
            trigger={
              <Button>
                <Send /> {t('quotesX.send')}
              </Button>
            }
            title={t('quotesX.send')}
            description={t('quotesX.sendHint')}
            onConfirm={async () => {
              await api(`/v1/quotes/${quote.id}/send`, { method: 'POST' });
              router.refresh();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('app.sandbox')}</p>
          </ActionDialog>
        ) : null}
        {has('ACCEPT') ? (
          <ActionDialog
            trigger={
              <Button variant="success">
                <Check /> {t('quotesX.accept')}
              </Button>
            }
            title={t('quotesX.accept')}
            description={t('quotesX.acceptHint')}
            variant="success"
            onConfirm={async () => {
              await api(`/v1/quotes/${quote.id}/accept`, {
                method: 'POST',
                json: { note: note.trim() || undefined },
              });
              router.refresh();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="accept-note">{t('quotesX.note')}</Label>
              <Textarea
                id="accept-note"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </ActionDialog>
        ) : null}
        {has('CONVERT_INVOICE') ? (
          <ActionDialog
            trigger={
              <Button variant="accent">
                <ArrowRightLeft /> {t('quotesX.convert')}
              </Button>
            }
            title={t('quotesX.convert')}
            description={t('quotesX.convertHint')}
            variant="accent"
            disabled={!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)}
            onConfirm={async () => {
              const r = await api(`/v1/quotes/${quote.id}/convert`, {
                method: 'POST',
                json: { target: 'INVOICE', dueDate },
              });
              router.push(`/business/invoices/${r.invoice.id}?organizationId=${organizationId}`);
              router.refresh();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="convert-due">{t('quotesX.convertDueDate')}</Label>
              <Input
                id="convert-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('quotesX.protectNote')}</p>
          </ActionDialog>
        ) : null}
        {has('DECLINE') ? (
          <ActionDialog
            trigger={
              <Button variant="ghost" className="text-destructive">
                <X /> {t('quotesX.decline')}
              </Button>
            }
            title={t('quotesX.decline')}
            description={t('quotesX.declineHint')}
            variant="destructive"
            onConfirm={async () => {
              await api(`/v1/quotes/${quote.id}/decline`, {
                method: 'POST',
                json: { reason: reason.trim() || undefined },
              });
              router.refresh();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="decline-reason">{t('invoicing.reason')}</Label>
              <Textarea
                id="decline-reason"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </ActionDialog>
        ) : null}
      </div>
      {quote.status === 'ACCEPTED' ? (
        <p className="text-xs text-muted-foreground">{t('quotesX.protectNote')}</p>
      ) : null}
    </div>
  );
}
