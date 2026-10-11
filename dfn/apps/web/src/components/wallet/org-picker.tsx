'use client';
import { useRouter } from 'next/navigation';
import { Select } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

export function OrgPicker({
  organizations,
  value,
  basePath,
  extra = '',
}: {
  organizations: Array<{ id: string; name: string }>;
  value: string;
  basePath: string;
  extra?: string;
}) {
  const router = useRouter();
  const { t } = useI18n();
  if (organizations.length <= 1) return null;
  return (
    <Select
      aria-label={t('wallet.organization')}
      className="w-64"
      value={value}
      onChange={(e) => router.push(`${basePath}?organizationId=${e.target.value}${extra}`)}
    >
      {organizations.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}
