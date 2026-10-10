'use client';
import * as React from 'react';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';
import { Field, Input } from '@/components/ui/form';
import type { ActionState } from '@/lib/action-state';

type Action = (s: ActionState, f: FormData) => Promise<ActionState>;
type MfaStep = { mode: 'verify' } | { mode: 'enrol'; qrCodeDataUrl?: string; secret: string };

/**
 * Supabase MFA (real users): step 1 asks the server whether to verify an existing TOTP factor or to enrol one;
 * step 2 submits the code. Every provider call happens in server actions; no key or token reaches the browser.
 */
export function ProviderMfa({ next, prepare, verify }: { next: string; prepare: Action; verify: Action }) {
    const { t } = useI18n();
    const [step, setStep] = React.useState<MfaStep>();
    const onPrepared = React.useCallback((state: ActionState) => setStep(state.data as MfaStep), []);

    if (!step) {
        return (
            <ActionForm action={prepare} onSuccess={onPrepared} className="space-y-3">
                <p className="text-sm text-muted-foreground">{t('mfa.startHelp')}</p>
                <SubmitButton className="w-full">{t('mfa.start')}</SubmitButton>
            </ActionForm>
        );
    }
    return (
        <div className="space-y-4">
            {step.mode === 'enrol' && (
                <section className="space-y-3 rounded-lg border p-3" aria-labelledby="mfa-enrol-title">
                    <h2 id="mfa-enrol-title" className="text-sm font-semibold">
                        {t('mfa.enrolTitle')}
                    </h2>
                    <p className="text-xs text-muted-foreground">{t('mfa.enrolHelp')}</p>
                    {step.qrCodeDataUrl && (
                        // A data: URL generated server-side from the provider's SVG; next/image adds nothing here.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={step.qrCodeDataUrl}
                            alt={t('mfa.qrAlt')}
                            width={176}
                            height={176}
                            className="mx-auto rounded-md bg-white p-2"
                        />
                    )}
                    <div className="space-y-1">
                        <p className="text-xs font-medium">{t('mfa.secretLabel')}</p>
                        <code className="block rounded bg-muted px-2 py-1 font-mono text-sm break-all select-all" data-testid="totp-secret">
                            {step.secret}
                        </code>
                    </div>
                </section>
            )}
            <ActionForm action={verify} className="space-y-4">
                <input type="hidden" name="next" value={next} />
                <Field label={t('mfa.code')} htmlFor="code">
                    <Input
                        id="code"
                        name="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="\d{6}"
                        maxLength={6}
                        required
                        autoFocus
                        className="text-center font-mono text-lg tracking-[0.5em]"
                    />
                </Field>
                <SubmitButton className="w-full">{t('mfa.verify')}</SubmitButton>
            </ActionForm>
        </div>
    );
}
