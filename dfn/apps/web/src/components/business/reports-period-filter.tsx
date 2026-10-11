'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Filter, RotateCcw } from 'lucide-react';
import { CURRENCIES } from '@dfn/shared';
import { Button, Input, Label, Select } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

export interface ReportFilterValues {
  from?: string;
  to?: string;
  currencyCode?: string;
}

export function reportsQuery(organizationId: string, f: ReportFilterValues = {}) {
  const qs = new URLSearchParams({ organizationId });
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
  if (f.currencyCode) qs.set('currencyCode', f.currencyCode);
  return qs.toString();
}

/** Period / currency filter of the reports page (URL-driven). */
export function ReportsPeriodFilter({
  organizationId,
  values,
}: {
  organizationId: string;
  values: ReportFilterValues;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<ReportFilterValues>({
    from: values.from ?? '',
    to: values.to ?? '',
    currencyCode: values.currencyCode ?? '',
  });
  const dirty = Boolean(values.from || values.to || values.currencyCode);
  return (
    <form
      className="grid gap-3 sm:grid-cols-4 sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/business/reports?${reportsQuery(organizationId, form)}`);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="r-from">{t('reportsX.from')}</Label>
        <Input
          id="r-from"
          type="date"
          value={form.from}
          max={form.to || undefined}
          onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="r-to">{t('reportsX.to')}</Label>
        <Input
          id="r-to"
          type="date"
          value={form.to}
          min={form.from || undefined}
          onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="r-ccy">{t('reportsX.currency')}</Label>
        <Select
          id="r-ccy"
          value={form.currencyCode}
          onChange={(e) => setForm((f) => ({ ...f, currencyCode: e.target.value }))}
        >
          <option value="">{t('common.all')}</option>
          {Object.keys(CURRENCIES).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          <Filter /> {t('reportsX.apply')}
        </Button>
        {dirty ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setForm({ from: '', to: '', currencyCode: '' });
              router.push(`/business/reports?${reportsQuery(organizationId)}`);
            }}
          >
            <RotateCcw /> {t('reportsX.reset')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
