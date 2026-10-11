'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { CURRENCIES, minorToDecimalString, parseDecimalToMinor } from '@dfn/shared';
import { Button, Input, Label, Select, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { formatMoney, type MoneyDto } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

export interface CounterpartyOption {
  id: string;
  name: string;
  email: string | null;
}

interface LineState {
  description: string;
  quantity: string;
  unitPrice: string;
}

export interface DocumentFormInitial {
  id: string;
  counterparty: { id: string } | null;
  customerName: string;
  customerEmail: string | null;
  currencyCode: string;
  /** dueDate (invoice) or validUntil (quote) as ISO string. */
  date: string;
  taxBps: number;
  notes: string | null;
  transactionId?: string | null;
  lines: Array<{ description: string; quantity: number; unitPrice: MoneyDto }>;
}

/** "18" or "18.5" (percent) → basis points, integer arithmetic only. */
export function percentToBps(value: string): number | null {
  const str = value.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** Live totals with the same integer rules as the API (half-up tax). */
export function computeLiveTotals(lines: LineState[], currencyCode: string, taxBps: number) {
  let subtotal = 0n;
  let invalid = false;
  const perLine = lines.map((line) => {
    try {
      const qty = Number(line.quantity);
      if (!Number.isInteger(qty) || qty < 1 || line.description.trim().length === 0)
        throw new Error('invalid');
      const unit = parseDecimalToMinor(line.unitPrice, currencyCode);
      const total = unit * BigInt(qty);
      subtotal += total;
      return { ok: true, total };
    } catch {
      invalid = true;
      return { ok: false, total: 0n };
    }
  });
  const tax = (subtotal * BigInt(taxBps) + 5_000n) / 10_000n;
  const money = (minor: bigint): MoneyDto => ({
    minor: minor.toString(),
    decimal: minorToDecimalString(minor, currencyCode),
    currency: currencyCode,
  });
  return {
    invalid,
    perLine: perLine.map((l) => ({ ok: l.ok, total: money(l.total) })),
    subtotal: money(subtotal),
    tax: money(tax),
    total: money(subtotal + tax),
    subtotalMinor: subtotal,
  };
}

const EMPTY_LINE: LineState = { description: '', quantity: '1', unitPrice: '' };

/**
 * Create / edit dialog shared by invoices and quotes: customer, currency, dynamic line items with
 * live integer totals, tax rate and notes. Posts to /v1/invoices or /v1/quotes.
 */
export function DocumentFormDialog({
  kind,
  organizationId,
  counterparties,
  initial,
  defaultDueDate,
  trigger,
}: {
  kind: 'INVOICE' | 'QUOTE';
  organizationId: string;
  counterparties: CounterpartyOption[];
  initial?: DocumentFormInitial;
  /** YYYY-MM-DD preset for the due date / validity in create mode (computed by the server page). */
  defaultDueDate?: string;
  trigger: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const isInvoice = kind === 'INVOICE';
  const ns = isInvoice ? 'invoicing' : 'quotesX';
  const [counterpartyId, setCounterpartyId] = useState(initial?.counterparty?.id ?? '');
  const [customerName, setCustomerName] = useState(initial?.customerName ?? '');
  const [customerEmail, setCustomerEmail] = useState(initial?.customerEmail ?? '');
  const [currencyCode, setCurrencyCode] = useState(initial?.currencyCode ?? 'CAD');
  const [date, setDate] = useState(initial ? initial.date.slice(0, 10) : (defaultDueDate ?? ''));
  const [taxPercent, setTaxPercent] = useState(initial ? bpsToPercent(initial.taxBps) : '0');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [transactionId, setTransactionId] = useState(initial?.transactionId ?? '');
  const [lines, setLines] = useState<LineState[]>(
    initial?.lines.length
      ? initial.lines.map((l) => ({
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: l.unitPrice.decimal,
        }))
      : [{ ...EMPTY_LINE }],
  );
  const taxBps = percentToBps(taxPercent);
  const totals = useMemo(
    () => computeLiveTotals(lines, currencyCode, taxBps ?? 0),
    [lines, currencyCode, taxBps],
  );
  const valid =
    customerName.trim().length > 0 &&
    taxBps !== null &&
    !totals.invalid &&
    totals.subtotalMinor > 0n &&
    /^\d{4}-\d{2}-\d{2}$/.test(date);

  function updateLine(index: number, patch: Partial<LineState>) {
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function pickCounterparty(id: string) {
    setCounterpartyId(id);
    const cp = counterparties.find((c) => c.id === id);
    if (cp) {
      setCustomerName(cp.name);
      if (cp.email) setCustomerEmail(cp.email);
    }
  }

  async function submit() {
    const payload: Record<string, unknown> = {
      organizationId,
      counterpartyId: counterpartyId || undefined,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim() || undefined,
      currencyCode,
      taxBps: taxBps ?? 0,
      notes: notes.trim() || undefined,
      lines: lines.map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unitPrice: l.unitPrice.trim().replace(',', '.'),
      })),
      ...(isInvoice
        ? { dueDate: date, transactionId: transactionId.trim() || undefined }
        : { validUntil: date }),
    };
    const base = isInvoice ? '/v1/invoices' : '/v1/quotes';
    if (initial) {
      await api(`${base}/${initial.id}`, { method: 'PATCH', json: payload });
      router.refresh();
      return;
    }
    const created = await api(base, { method: 'POST', json: payload });
    router.push(
      `/business/${isInvoice ? 'invoices' : 'quotes'}/${created.id}?organizationId=${organizationId}`,
    );
    router.refresh();
  }

  const prefix = isInvoice ? 'inv' : 'quo';
  return (
    <ActionDialog
      trigger={trigger}
      title={initial ? t(`${ns}.edit`) : t(`${ns}.new`)}
      description={t('app.sandbox')}
      confirmLabel={initial ? t('common.save') : t('common.confirm')}
      disabled={!valid}
      onConfirm={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {counterparties.length ? (
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`${prefix}-cp`}>{t('invoicing.counterparty')}</Label>
            <Select
              id={`${prefix}-cp`}
              value={counterpartyId}
              onChange={(e) => pickCounterparty(e.target.value)}
            >
              <option value="">{t('invoicing.noCounterparty')}</option>
              {counterparties.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-name`}>{t('invoicing.customerName')}</Label>
          <Input
            id={`${prefix}-name`}
            required
            maxLength={160}
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-email`}>{t('invoicing.customerEmail')}</Label>
          <Input
            id={`${prefix}-email`}
            type="email"
            value={customerEmail}
            onChange={(e) => setCustomerEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-ccy`}>{t('invoicing.currency')}</Label>
          <Select id={`${prefix}-ccy`} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
            {Object.values(CURRENCIES).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} ({c.symbol})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-date`}>
            {isInvoice ? t('invoicing.dueDate') : t('quotesX.validUntil')}
          </Label>
          <Input
            id={`${prefix}-date`}
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-tax`}>{t('invoicing.taxRate')}</Label>
          <Input
            id={`${prefix}-tax`}
            inputMode="decimal"
            value={taxPercent}
            onChange={(e) => setTaxPercent(e.target.value)}
            aria-invalid={taxBps === null}
          />
          <p className="text-xs text-muted-foreground">{t('invoicing.taxRateHint')}</p>
        </div>
        {isInvoice ? (
          <div className="space-y-1">
            <Label htmlFor={`${prefix}-tx`}>{t('invoicing.transactionId')}</Label>
            <Input
              id={`${prefix}-tx`}
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              placeholder="uuid"
            />
            <p className="text-xs text-muted-foreground">{t('invoicing.transactionIdHint')}</p>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t('invoicing.lines')}</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}
            disabled={lines.length >= 50}
          >
            <Plus /> {t('invoicing.addLine')}
          </Button>
        </div>
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-md border p-2">
              <div className="col-span-12 space-y-1 sm:col-span-5">
                <Label htmlFor={`${prefix}-l${i}-d`} className="text-xs">
                  {t('invoicing.description')}
                </Label>
                <Input
                  id={`${prefix}-l${i}-d`}
                  maxLength={200}
                  value={line.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                />
              </div>
              <div className="col-span-4 space-y-1 sm:col-span-2">
                <Label htmlFor={`${prefix}-l${i}-q`} className="text-xs">
                  {t('invoicing.quantity')}
                </Label>
                <Input
                  id={`${prefix}-l${i}-q`}
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                />
              </div>
              <div className="col-span-5 space-y-1 sm:col-span-3">
                <Label htmlFor={`${prefix}-l${i}-p`} className="text-xs">
                  {t('invoicing.unitPrice')} ({currencyCode})
                </Label>
                <Input
                  id={`${prefix}-l${i}-p`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={line.unitPrice}
                  aria-invalid={!totals.perLine[i]?.ok}
                  onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                />
              </div>
              <div className="col-span-3 flex items-center justify-between gap-1 sm:col-span-2">
                <span className="text-sm tabular-nums">
                  {totals.perLine[i]?.ok ? formatMoney(totals.perLine[i].total, locale) : '—'}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('invoicing.removeLine')}
                  disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
        {totals.invalid ? <p className="text-xs text-destructive">{t('invoicing.invalidLine')}</p> : null}
        {!totals.invalid && totals.subtotalMinor === 0n ? (
          <p className="text-xs text-destructive">{t('invoicing.totalZero')}</p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${prefix}-notes`}>{t('invoicing.notes')}</Label>
        <Textarea
          id={`${prefix}-notes`}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <dl className="grid grid-cols-2 gap-1 rounded-md bg-muted/50 p-3 text-sm">
        <dt className="text-muted-foreground">{t('invoicing.subtotal')}</dt>
        <dd className="text-right tabular-nums">{formatMoney(totals.subtotal, locale)}</dd>
        <dt className="text-muted-foreground">
          {t('invoicing.tax')} ({taxBps === null ? '?' : bpsToPercent(taxBps)} %)
        </dt>
        <dd className="text-right tabular-nums">{formatMoney(totals.tax, locale)}</dd>
        <dt className="font-medium">{t('invoicing.total')}</dt>
        <dd className="text-right font-semibold tabular-nums">{formatMoney(totals.total, locale)}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">{t('invoicing.previewHint')}</p>
    </ActionDialog>
  );
}
