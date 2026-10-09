'use client';
import * as React from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { documentUrlAction } from '@/app/actions/transactions';
import { useI18n } from '@/components/app/i18n-provider';
import { Button } from '@/components/ui/button';
import { initialActionState, type ActionState } from '@/lib/action-state';

/** Requests a short-lived signed URL (logged server-side) and opens it. */
export function OpenDocumentButton({ documentId, disabled }: { documentId: string; disabled?: boolean }) {
    const { t } = useI18n();
    const [pending, start] = React.useTransition();
    const [error, setError] = React.useState<string>();
    return (
        <span className="inline-flex flex-col items-end gap-1">
            <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled || pending}
                title={t('documents.accessNote')}
                onClick={() =>
                    start(async () => {
                        const form = new FormData();
                        form.set('documentId', documentId);
                        const r: ActionState<{ url: string }> = await documentUrlAction(initialActionState, form);
                        if (r.ok && r.data) window.open(r.data.url, '_blank', 'noopener,noreferrer');
                        else setError(t(`errors.${r.error?.code ?? 'INTERNAL'}`));
                    })
                }
            >
                {pending ? <Loader2 className="animate-spin" aria-hidden /> : <ExternalLink aria-hidden />}
                {t('documents.open')}
            </Button>
            {error && (
                <span className="text-xs text-danger" role="alert">
                    {error}
                </span>
            )}
        </span>
    );
}
