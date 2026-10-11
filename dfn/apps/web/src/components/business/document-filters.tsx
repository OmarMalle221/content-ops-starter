'use client';
import { useRouter } from 'next/navigation';
import { InvoiceStatus, QuoteStatus } from '@dfn/shared';
import { Input, Select } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

/** Status / scope / search filters of the invoices and quotes tables. URL-driven (server refetch). */
export function DocumentFilters({
  kind,
  organizationId,
  status,
  search,
  scope,
}: {
  kind: 'INVOICE' | 'QUOTE';
  organizationId: string;
  status?: string;
  search?: string;
  scope?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const basePath = kind === 'INVOICE' ? '/business/invoices' : '/business/quotes';
  const statuses = Object.values(kind === 'INVOICE' ? InvoiceStatus : QuoteStatus);
  function update(next: Record<string, string | undefined>) {
    const params = new URLSearchParams({ organizationId });
    const merged = { status, search, scope, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    router.push(`${basePath}?${params.toString()}`);
  }
  return (
    <div className="flex flex-wrap gap-3">
      <Select
        aria-label={t('common.status')}
        className="w-56"
        value={status ?? ''}
        onChange={(e) => update({ status: e.target.value || undefined })}
      >
        <option value="">{t('invoicing.allStatuses')}</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {t(`status.${s}`)}
          </option>
        ))}
      </Select>
      {kind === 'INVOICE' ? (
        <Select
          aria-label={t('invoicing.scope')}
          className="w-56"
          value={scope ?? 'ISSUED'}
          onChange={(e) => update({ scope: e.target.value === 'RECEIVED' ? 'RECEIVED' : undefined })}
        >
          <option value="ISSUED">{t('invoicing.issued')}</option>
          <option value="RECEIVED">{t('invoicing.received')}</option>
        </Select>
      ) : null}
      <Input
        aria-label={t('common.search')}
        className="w-64"
        placeholder={t('common.search')}
        defaultValue={search ?? ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') update({ search: (e.target as HTMLInputElement).value || undefined });
        }}
      />
    </div>
  );
}
