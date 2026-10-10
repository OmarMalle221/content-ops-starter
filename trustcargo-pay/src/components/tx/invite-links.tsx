'use client';
import * as React from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { useI18n } from '@/components/app/i18n-provider';
import { Alert } from '@/components/ui/alert';

export function InviteLinks({ links }: { links: { role: string; email: string; url: string }[] }) {
    const { t } = useI18n();
    const [copied, setCopied] = React.useState<string>();
    return (
        <Alert tone="success" title={t('tx.inviteDone')}>
            <ul className="mt-2 space-y-3">
                {links.map((l) => (
                    <li key={l.url} className="space-y-1">
                        <p className="text-xs font-medium">
                            {t('partyRole.' + l.role)} — {t('wizard.inviteLink', { email: l.email })}
                        </p>
                        <div className="flex items-center gap-2">
                            <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <code
                                className="min-w-0 flex-1 truncate rounded border bg-card px-2 py-1 font-mono text-xs"
                                data-testid="invite-link"
                            >
                                {l.url}
                            </code>
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs hover:bg-muted"
                                onClick={async () => {
                                    await navigator.clipboard?.writeText(l.url);
                                    setCopied(l.url);
                                }}
                            >
                                {copied === l.url ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                                {copied === l.url ? t('common.copied') : t('common.copy')}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
            <p className="mt-2 text-xs">{t('wizard.inviteHelp')}</p>
        </Alert>
    );
}
