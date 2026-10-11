'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check /> : <Copy />} {done ? t('common.copied') : (label ?? t('common.copy'))}
    </Button>
  );
}
