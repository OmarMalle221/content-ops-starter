'use client';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, RefreshCw, Users } from 'lucide-react';
import { CORRIDORS, COUNTRIES, SUPPORTED_CURRENCY_CODES } from '@dfn/shared';
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
  Stepper,
  type Step,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatDate, formatMoney, type MoneyDto } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { StatusBadge } from '@/components/status-badge';
import { AuthorizeTransferDialog } from './authorize-dialog';
import { QuoteCountdown } from './quote-countdown';
import { TRANSFER_PURPOSES, type BeneficiaryDto, type FxQuoteDto, type TransferDto } from './types';

const AMOUNT_RE = /^\d{1,13}([.,]\d{1,2})?$/;

export interface WalletBalance {
  currencyCode: string;
  balance: MoneyDto;
}

/**
 * Three-step creation flow. Every amount, rate and fee comes from the API (the browser never
 * computes money); the quote countdown runs client-side only.
 */
export function NewTransferFlow({
  organizationId,
  beneficiaries,
  walletBalances,
  mfaEnabled,
  canAuthorize,
}: {
  organizationId: string;
  beneficiaries: BeneficiaryDto[];
  walletBalances: WalletBalance[];
  mfaEnabled: boolean;
  canAuthorize: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [corridor, setCorridor] = useState(`${CORRIDORS[0].origin}-${CORRIDORS[0].destination}`);
  const [origin, destination] = corridor.split('-');
  const [sourceCurrency, setSourceCurrency] = useState(COUNTRIES[origin].defaultCurrency);
  const [destinationCurrency, setDestinationCurrency] = useState(COUNTRIES[destination].defaultCurrency);
  const [amount, setAmount] = useState('100.00');
  const [quote, setQuote] = useState<FxQuoteDto | null>(null);
  const [quoteExpired, setQuoteExpired] = useState(false);
  const [beneficiaryId, setBeneficiaryId] = useState('');
  const [purpose, setPurpose] = useState<(typeof TRANSFER_PURPOSES)[number]>('FAMILY_SUPPORT');
  const [clientReference, setClientReference] = useState('');
  const [transfer, setTransfer] = useState<TransferDto | null>(null);
  const [loading, setLoading] = useState<'quote' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountValid = AMOUNT_RE.test(amount.trim());
  const step = transfer ? 3 : quote ? 2 : 1;
  const eligibleBeneficiaries = useMemo(
    () =>
      beneficiaries.filter(
        (b) =>
          b.status === 'ACTIVE' &&
          b.country === (quote?.destinationCountry ?? destination) &&
          b.currencyCode === (quote?.destination.currency ?? destinationCurrency),
      ),
    [beneficiaries, quote, destination, destinationCurrency],
  );
  const selectedBeneficiary = eligibleBeneficiaries.find((b) => b.id === beneficiaryId) ?? null;
  const sourceBalance = walletBalances.find((w) => w.currencyCode === sourceCurrency)?.balance ?? null;
  const onExpire = useCallback(() => setQuoteExpired(true), []);

  function changeCorridor(value: string) {
    setCorridor(value);
    const [o, d] = value.split('-');
    setSourceCurrency(COUNTRIES[o].defaultCurrency);
    setDestinationCurrency(COUNTRIES[d].defaultCurrency);
  }

  async function requestQuote() {
    setLoading('quote');
    setError(null);
    try {
      const q = await api<FxQuoteDto>('/v1/transfers/quotes', {
        method: 'POST',
        json: {
          organizationId,
          originCountry: origin,
          destinationCountry: destination,
          sourceCurrency,
          destinationCurrency,
          amount: amount.trim().replace(',', '.'),
        },
      });
      setQuote(q);
      setQuoteExpired(false);
      setBeneficiaryId((current) => {
        const stillEligible = beneficiaries.some(
          (b) =>
            b.id === current &&
            b.status === 'ACTIVE' &&
            b.country === (q.destinationCountry ?? destination) &&
            b.currencyCode === q.destination.currency,
        );
        if (stillEligible) return current;
        const first = beneficiaries.find(
          (b) =>
            b.status === 'ACTIVE' &&
            b.country === (q.destinationCountry ?? destination) &&
            b.currencyCode === q.destination.currency,
        );
        return first?.id ?? '';
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  }

  async function createTransfer() {
    if (!quote || !selectedBeneficiary) return;
    setLoading('create');
    setError(null);
    try {
      const created = await api<TransferDto>('/v1/transfers', {
        method: 'POST',
        json: {
          quoteId: quote.id,
          beneficiaryId: selectedBeneficiary.id,
          purpose,
          ...(clientReference.trim() ? { reference: clientReference.trim() } : {}),
        },
      });
      setTransfer(created);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  }

  const steps: Step[] = [
    { key: 'quote', label: t('xfer.steps.quote'), state: step > 1 ? 'done' : 'current' },
    {
      key: 'details',
      label: t('xfer.steps.details'),
      state: step > 2 ? 'done' : step === 2 ? 'current' : 'upcoming',
    },
    { key: 'authorize', label: t('xfer.steps.authorize'), state: step === 3 ? 'current' : 'upcoming' },
  ];

  return (
    <div className="space-y-6">
      <Stepper steps={steps} className="lg:grid-cols-3" />
      <FormMessage error={error} />

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('xfer.stepOf')} 1 — {t('xfer.steps.quote')}
            </CardTitle>
            <CardDescription>{t('xfer.quoteHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="xfer-corridor">{t('xfer.corridor')}</Label>
                <Select id="xfer-corridor" value={corridor} onChange={(e) => changeCorridor(e.target.value)}>
                  {CORRIDORS.map((c) => (
                    <option key={`${c.origin}-${c.destination}`} value={`${c.origin}-${c.destination}`}>
                      {COUNTRIES[c.origin].name[locale]} → {COUNTRIES[c.destination].name[locale]} (
                      {t(`xfer.corridorStatus.${c.status}`)})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="xfer-amount">{t('xfer.amount')}</Label>
                <Input
                  id="xfer-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={!amountValid}
                />
                {sourceBalance ? (
                  <p className="text-xs text-muted-foreground">
                    {t('xfer.walletBalance')} {formatMoney(sourceBalance, locale)}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="xfer-source-currency">{t('xfer.sourceCurrency')}</Label>
                <Select
                  id="xfer-source-currency"
                  value={sourceCurrency}
                  onChange={(e) => setSourceCurrency(e.target.value)}
                >
                  {SUPPORTED_CURRENCY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="xfer-destination-currency">{t('xfer.destinationCurrency')}</Label>
                <Select
                  id="xfer-destination-currency"
                  value={destinationCurrency}
                  onChange={(e) => setDestinationCurrency(e.target.value)}
                >
                  {SUPPORTED_CURRENCY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={requestQuote} loading={loading === 'quote'} disabled={!amountValid}>
                {t('xfer.getQuote')} <ArrowRight />
              </Button>
              <Badge variant="sandbox">{t('app.sandbox')}</Badge>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 && quote ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>
                  {t('xfer.stepOf')} 2 — {t('xfer.steps.details')}
                </CardTitle>
                <QuoteCountdown expiresAt={quote.expiresAt} onExpire={onExpire} />
              </div>
              <CardDescription>
                {COUNTRIES[origin].name[locale]} → {COUNTRIES[destination].name[locale]} · {quote.provider} ·{' '}
                {t('common.simulated').toLowerCase()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('xfer.amount')}</p>
                  <p className="text-lg font-semibold tabular-nums">{formatMoney(quote.source, locale)}</p>
                </div>
                <ArrowRight className="size-5 text-muted-foreground" />
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t('xfer.received')}
                  </p>
                  <p className="text-lg font-semibold tabular-nums text-primary">
                    {formatMoney(quote.destination, locale)}
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('xfer.rate')}</dt>
                <dd className="text-right tabular-nums">{quote.rate.display}</dd>
                <dt className="text-muted-foreground">{t('xfer.spread')}</dt>
                <dd className="text-right tabular-nums">{quote.spreadBps ?? '—'} bps</dd>
                <dt className="text-muted-foreground">{t('xfer.fee')}</dt>
                <dd className="text-right tabular-nums">{formatMoney(quote.fee, locale)}</dd>
                <dt className="text-muted-foreground">{t('xfer.totalDebit')}</dt>
                <dd className="text-right font-medium tabular-nums">
                  {formatMoney(quote.totalDebit, locale)}
                </dd>
                <dt className="text-muted-foreground">{t('xfer.quoteExpires')}</dt>
                <dd className="text-right">{formatDate(quote.expiresAt, locale, true)}</dd>
              </dl>
              {quoteExpired ? <FormMessage error={t('xfer.quoteExpired')} /> : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={requestQuote} loading={loading === 'quote'}>
                  <RefreshCw /> {t('xfer.requote')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuote(null);
                    setQuoteExpired(false);
                  }}
                >
                  {t('common.back')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('xfer.quoteHint')} · {t('app.sandbox')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('xfer.beneficiary')}</CardTitle>
              <CardDescription>
                {COUNTRIES[quote.destinationCountry ?? destination]?.name[locale]} ·{' '}
                {quote.destination.currency}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {eligibleBeneficiaries.length === 0 ? (
                <div className="space-y-3 rounded-lg border border-dashed p-4 text-sm">
                  <p className="text-muted-foreground">{t('xfer.noBeneficiary')}</p>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/wallet/beneficiaries?organizationId=${organizationId}`}>
                      <Users /> {t('xfer.manageBeneficiaries')}
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="xfer-beneficiary">{t('xfer.selectBeneficiary')}</Label>
                  <Select
                    id="xfer-beneficiary"
                    value={beneficiaryId}
                    onChange={(e) => setBeneficiaryId(e.target.value)}
                  >
                    {eligibleBeneficiaries.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} · {b.accountIdentifierMasked}
                        {b.institutionName ? ` · ${b.institutionName}` : ''}
                      </option>
                    ))}
                  </Select>
                  <Link
                    href={`/wallet/beneficiaries?organizationId=${organizationId}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Users className="size-3" /> {t('xfer.manageBeneficiaries')}
                  </Link>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="xfer-purpose">{t('xfer.purpose')}</Label>
                <Select
                  id="xfer-purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value as (typeof TRANSFER_PURPOSES)[number])}
                >
                  {TRANSFER_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {t(`xfer.purposes.${p}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="xfer-client-reference">{t('xfer.clientReference')}</Label>
                <Input
                  id="xfer-client-reference"
                  maxLength={60}
                  value={clientReference}
                  onChange={(e) => setClientReference(e.target.value)}
                />
              </div>
              <Button
                onClick={createTransfer}
                loading={loading === 'create'}
                disabled={!selectedBeneficiary || quoteExpired}
              >
                {t('xfer.createTransfer')} <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === 3 && transfer ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                {t('xfer.stepOf')} 3 — {t('xfer.steps.authorize')}
              </CardTitle>
              <StatusBadge status={transfer.status} />
            </div>
            <CardDescription>
              {transfer.reference} · {t('xfer.created')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-4 text-sm sm:grid-cols-2">
              <dt className="text-muted-foreground">{t('xfer.beneficiary')}</dt>
              <dd className="sm:text-right">
                {transfer.beneficiary.name} · {transfer.beneficiary.accountIdentifierMasked}
              </dd>
              <dt className="text-muted-foreground">{t('xfer.totalDebit')}</dt>
              <dd className="font-medium tabular-nums sm:text-right">
                {formatMoney(transfer.totalDebit, locale)}
              </dd>
              <dt className="text-muted-foreground">{t('xfer.received')}</dt>
              <dd className="font-medium tabular-nums text-primary sm:text-right">
                {formatMoney(transfer.destination, locale)}
              </dd>
              <dt className="text-muted-foreground">{t('xfer.rate')}</dt>
              <dd className="tabular-nums sm:text-right">{transfer.rate.display}</dd>
              {transfer.quoteExpiresAt ? (
                <>
                  <dt className="text-muted-foreground">{t('xfer.quoteExpires')}</dt>
                  <dd className="sm:text-right">
                    <QuoteCountdown expiresAt={transfer.quoteExpiresAt} />
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              {canAuthorize && transfer.nextActions.includes('AUTHORIZE') ? (
                <AuthorizeTransferDialog
                  transfer={transfer}
                  mfaEnabled={mfaEnabled}
                  variant="accent"
                  onDone={() => {
                    router.push(`/transfers/${transfer.id}`);
                    router.refresh();
                  }}
                />
              ) : null}
              <Button asChild variant="outline">
                <Link href={`/transfers/${transfer.id}`}>
                  {canAuthorize ? t('xfer.authorizeLater') : t('xfer.viewTransfer')} <ArrowRight />
                </Link>
              </Button>
              <Badge variant="sandbox">{t('app.sandbox')}</Badge>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
