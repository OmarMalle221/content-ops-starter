'use client';
import { Badge } from '@dfn/ui';
import { statusVariant } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';

/** Entities whose statuses share a code with another entity but need their own wording. */
export type StatusEntity = 'quote' | 'transfer' | 'invoice';

export function StatusBadge({
  status,
  className,
  entity,
}: {
  status: string;
  className?: string;
  entity?: StatusEntity;
}) {
  const { t } = useI18n();
  // Entity-specific wording first (e.g. an ACCEPTED quote is « Accepté », not the Protect
  // « Conditions à accepter »), then the shared status label, then the raw code.
  const specificKey = entity ? `statusByEntity.${entity}.${status}` : null;
  const specific = specificKey ? t(specificKey) : null;
  const shared = t(`status.${status}`);
  const label =
    specific && specific !== specificKey ? specific : shared === `status.${status}` ? status : shared;
  return (
    <Badge variant={statusVariant(status)} className={className}>
      {label}
    </Badge>
  );
}
