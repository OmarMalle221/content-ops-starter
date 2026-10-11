'use client';
import { useRouter } from 'next/navigation';
import { TransactionStatus } from '@dfn/shared';
import { Input, Select } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

export function TransactionsFilters({
  role,
  status,
  search,
}: {
  role?: string;
  status?: string;
  search?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  function update(next: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    const merged = { role, status, search, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    router.push(`/transactions?${params.toString()}`);
  }
  return (
    <div className="flex flex-wrap gap-3">
      <Select
        aria-label={t('tx.filterRole')}
        className="w-44"
        value={role ?? ''}
        onChange={(e) => update({ role: e.target.value || undefined })}
      >
        <option value="">
          {t('tx.filterRole')}: {t('common.all')}
        </option>
        <option value="BUYER">{t('roles.BUYER')}</option>
        <option value="SELLER">{t('roles.SELLER')}</option>
      </Select>
      <Select
        aria-label={t('tx.filterStatus')}
        className="w-56"
        value={status ?? ''}
        onChange={(e) => update({ status: e.target.value || undefined })}
      >
        <option value="">
          {t('tx.filterStatus')}: {t('common.all')}
        </option>
        {Object.values(TransactionStatus).map((s) => (
          <option key={s} value={s}>
            {t(`status.${s}`)}
          </option>
        ))}
      </Select>
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
