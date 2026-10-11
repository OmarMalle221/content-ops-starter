'use client';
import { ExternalLink } from 'lucide-react';
import { Button } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';
import { CopyButton } from '@/components/copy-button';

/** Plain-text printable rendering returned by GET /v1/{invoices|quotes}/:id/document. */
export function PrintableDocument({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
            window.open(url, '_blank', 'noopener');
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}
        >
          <ExternalLink /> {t('invoicing.openPrintable')}
        </Button>
        <CopyButton value={text} label={t('invoicing.copyText')} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}
