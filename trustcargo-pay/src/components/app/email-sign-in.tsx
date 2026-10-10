'use client';
import { Mail } from 'lucide-react';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Field, Input } from '@/components/ui/form';
import type { ActionState } from '@/lib/action-state';

/** Magic-link request (Supabase Auth). The confirmation is identical whatever the address. */
export function EmailSignIn({ action }: { action: (s: ActionState, f: FormData) => Promise<ActionState> }) {
    const { t } = useI18n();
    return (
        <ActionForm action={action} className="space-y-3">
            {(state) =>
                state.ok ? (
                    <Alert tone="success" title={t('auth.linkSentTitle')}>
                        <p>{t('auth.linkSent')}</p>
                    </Alert>
                ) : (
                    <>
                        <Field label={t('auth.email')} htmlFor="email">
                            <Input id="email" name="email" type="email" inputMode="email" autoComplete="email" maxLength={254} required />
                        </Field>
                        <SubmitButton className="w-full">
                            <Mail aria-hidden />
                            {t('auth.sendLink')}
                        </SubmitButton>
                    </>
                )
            }
        </ActionForm>
    );
}
