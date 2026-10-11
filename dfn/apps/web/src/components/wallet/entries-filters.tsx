'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Filter, RotateCcw } from 'lucide-react';
import { LedgerTransactionKind } from '@dfn/shared';
import { Button, Input, Label, Select } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';
import { walletQuery, type EntriesFilterValues } from './wallet-query';

/** Kind / status / date-range filters of the operations table. Navigation is URL-driven (server refetch). */
export function EntriesFilters({
  organizationId,
  currency,
  values,
}: {
  organizationId: string;
  currency: string;
  values: EntriesFilterValues;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<EntriesFilterValues>({
    kind: values.kind ?? '',
    status: values.status ?? '',
    from: values.from ?? '',
    to: values.to ?? '',
  });
  const dirty = Boolean(values.kind || values.status || values.from || values.to);
  return (
    <form
      className="grid gap-3 sm:grid-cols-5 sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/wallet?${walletQuery(organizationId, currency, form)}`);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="f-kind">{t('walletPlus.kind')}</Label>
        <Select
          id="f-kind"
          value={form.kind}
          onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
        >
          <option value="">{t('walletPlus.allKinds')}</option>
          {Object.values(LedgerTransactionKind).map((k) => (
            <option key={k} value={k}>
              {t(`walletPlus.kinds.${k}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-status">{t('common.status')}</Label>
        <Select
          id="f-status"
          value={form.status}
          onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
        >
          <option value="">{t('walletPlus.allStatuses')}</option>
          <option value="POSTED">{t('walletPlus.statuses.POSTED')}</option>
          <option value="REVERSED">{t('walletPlus.statuses.REVERSED')}</option>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-from">{t('walletPlus.from')}</Label>
        <Input
          id="f-from"
          type="date"
          value={form.from}
          max={form.to || undefined}
          onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-to">{t('walletPlus.to')}</Label>
        <Input
          id="f-to"
          type="date"
          value={form.to}
          min={form.from || undefined}
          onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          <Filter /> {t('walletPlus.apply')}
        </Button>
        {dirty ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setForm({ kind: '', status: '', from: '', to: '' });
              router.push(`/wallet?${walletQuery(organizationId, currency)}`);
            }}
          >
            <RotateCcw /> {t('walletPlus.reset')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
