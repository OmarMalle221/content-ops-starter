'use client';
import { useRouter } from 'next/navigation';
import { Select } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';
import { TRANSFER_STATUSES } from './types';

/** Status filter: pushes the selection into the URL so the server page re-fetches. */
export function TransferFilters({
  basePath,
  organizationId,
  status,
}: {
  basePath: string;
  organizationId?: string;
  status?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <Select
      aria-label={t('xfer.filterStatus')}
      className="w-56"
      value={status ?? ''}
      onChange={(e) => {
        const params = new URLSearchParams();
        if (organizationId) params.set('organizationId', organizationId);
        if (e.target.value) params.set('status', e.target.value);
        router.push(params.size ? `${basePath}?${params.toString()}` : basePath);
      }}
    >
      <option value="">{t('xfer.allStatuses')}</option>
      {TRANSFER_STATUSES.map((s) => (
        <option key={s} value={s}>
          {t(`status.${s}`)}
        </option>
      ))}
    </Select>
  );
}
