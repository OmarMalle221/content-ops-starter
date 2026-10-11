'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { Badge, Button, Input, Label, Select } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney, type MoneyDto } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

export interface SelfDepositCurrency {
  currencyCode: string;
  remaining: MoneyDto;
  limit: MoneyDto;
  usedToday: MoneyDto;
}

const AMOUNT_RE = /^\d{1,13}([.,]\d{1,2})?$/;

/** Sandbox-only wallet top-up. Clearly labelled as fictitious and bounded by the daily cap. */
export function SelfDepositDialog({
  organizationId,
  currencies,
  defaultCurrency,
}: {
  organizationId: string;
  currencies: SelfDepositCurrency[];
  defaultCurrency: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [currency, setCurrency] = useState(
    currencies.some((c) => c.currencyCode === defaultCurrency)
      ? defaultCurrency
      : currencies[0]?.currencyCode,
  );
  const [amount, setAmount] = useState('');
  // One idempotency key per attempt: a retry after a network error replays instead of double-crediting.
  const keyRef = useRef<string | null>(null);
  const selected = currencies.find((c) => c.currencyCode === currency);
  const remainingMinor = selected ? BigInt(selected.remaining.minor) : 0n;
  const capReached = remainingMinor <= 0n;
  const amountValid = AMOUNT_RE.test(amount.trim());

  return (
    <ActionDialog
      trigger={
        <Button variant="accent">
          <FlaskConical /> {t('walletPlus.selfDeposit')}
        </Button>
      }
      title={t('walletPlus.selfDepositTitle')}
      description={t('walletPlus.selfDepositDescription')}
      confirmLabel={t('walletPlus.selfDeposit')}
      variant="accent"
      disabled={!amountValid || capReached}
      onConfirm={async () => {
        keyRef.current ??= crypto.randomUUID();
        try {
          await api('/v1/sandbox/wallets/self-deposit', {
            method: 'POST',
            json: {
              organizationId,
              currencyCode: currency,
              amount: amount.trim().replace(',', '.'),
              idempotencyKey: keyRef.current,
            },
          });
        } catch (e) {
          throw new Error(errorMessage(e));
        }
        keyRef.current = null;
        setAmount('');
        router.refresh();
      }}
    >
      <div className="flex items-center gap-2">
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="self-deposit-currency">{t('common.currency')}</Label>
          <Select
            id="self-deposit-currency"
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
              keyRef.current = null;
            }}
          >
            {currencies.map((c) => (
              <option key={c.currencyCode} value={c.currencyCode}>
                {c.currencyCode}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="self-deposit-amount">{t('common.amount')}</Label>
          <Input
            id="self-deposit-amount"
            inputMode="decimal"
            placeholder="1000.00"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              keyRef.current = null;
            }}
            disabled={capReached}
          />
        </div>
      </div>
      {selected ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
          <dt className="text-muted-foreground">{t('walletPlus.dailyCap')}</dt>
          <dd className="text-right tabular-nums">{formatMoney(selected.limit, locale)}</dd>
          <dt className="text-muted-foreground">{t('walletPlus.usedToday')}</dt>
          <dd className="text-right tabular-nums">{formatMoney(selected.usedToday, locale)}</dd>
          <dt className="text-muted-foreground">{t('walletPlus.remainingToday')}</dt>
          <dd className={`text-right tabular-nums font-medium ${capReached ? 'text-destructive' : ''}`}>
            {formatMoney(selected.remaining, locale)}
          </dd>
        </dl>
      ) : null}
      {capReached ? <p className="text-sm text-destructive">{t('walletPlus.capReached')}</p> : null}
    </ActionDialog>
  );
}
