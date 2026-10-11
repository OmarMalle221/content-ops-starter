'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Landmark, Pencil, Receipt, Send, Wallet } from 'lucide-react';
import { Button, Input, Label, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { DocumentFormDialog, type CounterpartyOption } from './document-form';

/** Invoice controls derived from the server-side `nextActions` list. */
export function InvoiceActions({
  invoice,
  organizationId,
  counterparties,
}: {
  invoice: any;
  organizationId: string;
  counterparties: CounterpartyOption[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const actions: string[] = invoice.nextActions ?? [];
  const has = (a: string) => actions.includes(a);
  const [amount, setAmount] = useState<string>(invoice.balanceDue?.decimal ?? '');
  const [reference, setReference] = useState('');
  const [walletAmount, setWalletAmount] = useState<string>(invoice.balanceDue?.decimal ?? '');
  const [reason, setReason] = useState('');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {has('EDIT') ? (
          <DocumentFormDialog
            kind="INVOICE"
            organizationId={organizationId}
            counterparties={counterparties}
            initial={{
              id: invoice.id,
              counterparty: invoice.counterparty,
              customerName: invoice.customerName,
              customerEmail: invoice.customerEmail,
              currencyCode: invoice.currencyCode,
              date: invoice.dueDate,
              taxBps: invoice.taxBps,
              notes: invoice.notes,
              transactionId: invoice.transactionId,
              lines: invoice.lines,
            }}
            trigger={
              <Button variant="outline">
                <Pencil /> {t('invoicing.edit')}
              </Button>
            }
          />
        ) : null}
        {has('SEND') ? (
          <ActionDialog
            trigger={
              <Button>
                <Send /> {t('invoicing.send')}
              </Button>
            }
            title={t('invoicing.send')}
            description={t('invoicing.sendHint')}
            onConfirm={async () => {
              await api(`/v1/invoices/${invoice.id}/send`, { method: 'POST' });
              router.refresh();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('app.sandbox')}</p>
          </ActionDialog>
        ) : null}
        {has('RECORD_PAYMENT') ? (
          <ActionDialog
            trigger={
              <Button variant="success">
                <Receipt /> {t('invoicing.recordPayment')}
              </Button>
            }
            title={t('invoicing.recordPayment')}
            description={t('invoicing.recordPaymentHint')}
            disabled={!/^\d{1,13}([.,]\d{1,2})?$/.test(amount.trim())}
            onConfirm={async () => {
              await api(`/v1/invoices/${invoice.id}/payments`, {
                method: 'POST',
                json: {
                  amount: amount.trim(),
                  method: 'EXTERNAL_RECORDED',
                  reference: reference.trim() || undefined,
                },
              });
              setReference('');
              router.refresh();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="pay-amount">
                {t('invoicing.amount')} ({invoice.currencyCode}) — {t('invoicing.balanceDue')}:{' '}
                {formatMoney(invoice.balanceDue, locale)}
              </Label>
              <Input
                id="pay-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pay-ref">{t('invoicing.reference')}</Label>
              <Input
                id="pay-ref"
                maxLength={120}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('invoicing.protectAuto')}</p>
          </ActionDialog>
        ) : null}
        {has('PAY_WALLET') ? (
          <ActionDialog
            trigger={
              <Button variant="accent">
                <Wallet /> {t('invoicing.payWallet')}
              </Button>
            }
            title={t('invoicing.payWallet')}
            description={t('invoicing.payWalletHint')}
            variant="accent"
            disabled={!/^\d{1,13}([.,]\d{1,2})?$/.test(walletAmount.trim())}
            onConfirm={async () => {
              await api(`/v1/invoices/${invoice.id}/payments`, {
                method: 'POST',
                json: {
                  amount: walletAmount.trim(),
                  method: 'WALLET_SIMULATED',
                  organizationId: invoice.counterparty?.linkedOrganizationId ?? undefined,
                },
              });
              router.refresh();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="wallet-amount">
                {t('invoicing.amount')} ({invoice.currencyCode}) — {t('invoicing.balanceDue')}:{' '}
                {formatMoney(invoice.balanceDue, locale)}
              </Label>
              <Input
                id="wallet-amount"
                inputMode="decimal"
                value={walletAmount}
                onChange={(e) => setWalletAmount(e.target.value)}
              />
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Landmark className="size-4" /> {t('app.sandbox')}
            </p>
          </ActionDialog>
        ) : null}
        {has('CANCEL') ? (
          <ActionDialog
            trigger={
              <Button variant="ghost" className="text-destructive">
                <Ban /> {t('invoicing.cancel')}
              </Button>
            }
            title={t('invoicing.cancel')}
            description={t('invoicing.cancelHint')}
            variant="destructive"
            onConfirm={async () => {
              await api(`/v1/invoices/${invoice.id}/cancel`, {
                method: 'POST',
                json: { reason: reason.trim() || undefined },
              });
              router.refresh();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="cancel-reason">{t('invoicing.reason')}</Label>
              <Textarea
                id="cancel-reason"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </ActionDialog>
        ) : null}
      </div>
      {invoice.transaction ? (
        <p className="text-xs text-muted-foreground">{t('invoicing.linkedTransactionHint')}</p>
      ) : null}
    </div>
  );
}
