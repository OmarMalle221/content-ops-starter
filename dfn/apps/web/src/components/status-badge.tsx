'use client';
import { Badge } from '@dfn/ui';
import { statusVariant } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useI18n();
  const label = t(`status.${status}`);
  return (
    <Badge variant={statusVariant(status)} className={className}>
      {label === `status.${status}` ? status : label}
    </Badge>
  );
}
