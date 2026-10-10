'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import type { ActionState } from '@/lib/action-state';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';

/** Sensitive action: opens a confirmation dialog, optional extra fields, then submits the server action. */
export function ConfirmAction({
    action,
    hidden,
    trigger,
    title,
    description,
    confirmLabel,
    variant = 'default',
    triggerVariant,
    size,
    children
}: {
    action: (state: ActionState, form: FormData) => Promise<ActionState>;
    hidden?: Record<string, string>;
    trigger: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmLabel: string;
    variant?: 'default' | 'destructive' | 'success';
    triggerVariant?: 'default' | 'secondary' | 'destructive' | 'success' | 'ghost';
    size?: 'default' | 'sm' | 'lg';
    children?: React.ReactNode;
}) {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant={triggerVariant ?? (variant === 'default' ? 'default' : variant)} size={size}>
                    {trigger}
                </Button>
            </DialogTrigger>
            <DialogContent title={title} description={description} closeLabel={t('common.close')}>
                <ActionForm action={action} onSuccess={() => setOpen(false)} className="space-y-4">
                    {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    {children}
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <SubmitButton variant={variant}>{confirmLabel}</SubmitButton>
                    </div>
                </ActionForm>
            </DialogContent>
        </Dialog>
    );
}
