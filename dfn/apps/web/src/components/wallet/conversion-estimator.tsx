'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Calculator } from 'lucide-react';
import { SUPPORTED_CURRENCY_CODES } from '@dfn/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney, type MoneyDto } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

interface Estimate {
  source: MoneyDto;
  destination: MoneyDto;
  rate: { numerator: string; denominator: string; display: string };
  spreadBps: number;
  fee: MoneyDto & { feeBps: number; fixedFee: MoneyDto | null };
  netSource: MoneyDto;
  estimatedReceived: MoneyDto;
  totalDebit: MoneyDto;
  provider: string;
  simulated: true;
}

const AMOUNT_RE = /^\d{1,13}([.,]\d{1,2})?$/;
const DEBOUNCE_MS = 400;

/** Live, debounced FX estimate through POST /v1/wallets/estimate. Nothing is persisted. */
export function ConversionEstimator({
  defaultSource = 'CAD',
  defaultDestination = 'XOF',
  organizationId,
}: {
  defaultSource?: string;
  defaultDestination?: string;
  organizationId?: string;
}) {
  const { t, locale } = useI18n();
  const [source, setSource] = useState(defaultSource);
  const [destination, setDestination] = useState(defaultDestination);
  const [amount, setAmount] = useState('100.00');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountValid = AMOUNT_RE.test(amount.trim());

  useEffect(() => {
    if (!amountValid) {
      setEstimate(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await api<Estimate>('/v1/wallets/estimate', {
          method: 'POST',
          json: { sourceCurrency: source, destinationCurrency: destination, amount: amount.trim() },
        });
        if (!cancelled) setEstimate(r);
      } catch (e) {
        if (!cancelled) {
          setEstimate(null);
          setError(errorMessage(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [source, destination, amount, amountValid]);

  const transferHref = organizationId ? `/transfers/new?organizationId=${organizationId}` : '/transfers/new';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Calculator className="size-4" /> {t('walletPlus.estimatorTitle')}
          </CardTitle>
          <Badge variant="sandbox">{t('common.simulated')}</Badge>
        </div>
        <CardDescription>{t('walletPlus.estimatorDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="fx-amount">{t('common.amount')}</Label>
            <Input
              id="fx-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!amountValid}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fx-source">{t('walletPlus.sourceCurrency')}</Label>
            <Select id="fx-source" value={source} onChange={(e) => setSource(e.target.value)}>
              {SUPPORTED_CURRENCY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fx-destination">{t('walletPlus.destinationCurrency')}</Label>
            <Select id="fx-destination" value={destination} onChange={(e) => setDestination(e.target.value)}>
              {SUPPORTED_CURRENCY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <FormMessage error={error} />
        {!amountValid ? (
          <p className="text-sm text-muted-foreground">{t('walletPlus.enterAmount')}</p>
        ) : loading && !estimate ? (
          <p className="text-sm text-muted-foreground">{t('walletPlus.estimating')}</p>
        ) : estimate ? (
          <div className={`space-y-3 ${loading ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('common.amount')}</p>
                <p className="text-lg font-semibold tabular-nums">{formatMoney(estimate.source, locale)}</p>
              </div>
              <ArrowRight className="size-5 text-muted-foreground" />
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('walletPlus.estimatedReceived')}
                </p>
                <p className="text-lg font-semibold tabular-nums text-primary">
                  {formatMoney(estimate.estimatedReceived, locale)}
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('walletPlus.rate')}</dt>
              <dd className="text-right tabular-nums">{estimate.rate.display}</dd>
              <dt className="text-muted-foreground">{t('walletPlus.spread')}</dt>
              <dd className="text-right tabular-nums">{estimate.spreadBps} bps</dd>
              <dt className="text-muted-foreground">{t('walletPlus.fee')}</dt>
              <dd className="text-right tabular-nums">+{formatMoney(estimate.fee, locale)}</dd>
              <dt className="text-muted-foreground">{t('walletPlus.totalDebit')}</dt>
              <dd className="text-right tabular-nums font-medium">
                {formatMoney(estimate.totalDebit, locale)}
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              {t('walletPlus.indicative')} · {estimate.provider} · {t('app.sandbox')}
            </p>
          </div>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link href={transferHref}>
            {t('walletPlus.newTransfer')} <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
