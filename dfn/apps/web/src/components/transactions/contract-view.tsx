'use client';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

export function ContractView({ bodyText }: { bodyText: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />{' '}
        {open ? t('common.close') : t('common.open')}
      </Button>
      {open ? (
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-4 text-xs leading-relaxed">
          {bodyText}
        </pre>
      ) : null}
    </div>
  );
}
