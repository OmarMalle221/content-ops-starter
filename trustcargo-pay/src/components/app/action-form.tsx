'use client';
import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { initialActionState, type ActionState } from '@/lib/action-state';
import { useI18n } from './i18n-provider';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function ErrorMessage({ error }: { error: NonNullable<ActionState['error']> }) {
    const { t } = useI18n();
    const items = [...(error.failedGuards ?? []).map((g) => t(`guard.${g}`)), ...(error.blockers ?? []).map((b) => t(`blocker.${b}`))];
    return (
        <Alert tone={error.code === 'MFA_REQUIRED' ? 'warning' : 'danger'} title={t(`errors.${error.code}`)}>
            {items.length > 0 && (
                <ul className="list-disc pl-4">
                    {items.map((i) => (
                        <li key={i}>{i}</li>
                    ))}
                </ul>
            )}
            {error.code === 'MFA_REQUIRED' && (
                <a
                    className="font-medium underline"
                    href={`/mfa?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/')}`}
                >
                    {t('mfa.verify')}
                </a>
            )}
            {error.fields && error.fields.length > 0 && <p className="text-xs">{error.fields.join(', ')}</p>}
            {!items.length && error.message && error.code !== 'VALIDATION' && <p className="text-xs">{error.message}</p>}
        </Alert>
    );
}

export function SubmitButton({ children, pendingLabel, ...props }: React.ComponentProps<typeof Button> & { pendingLabel?: string }) {
    const { pending } = useFormStatus();
    const { t } = useI18n();
    return (
        <Button type="submit" disabled={pending || props.disabled} aria-busy={pending} {...props}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {pending ? (pendingLabel ?? t('common.loading')) : children}
        </Button>
    );
}

/**
 * Progressive-enhancement form bound to a server action. Errors and success messages are
 * announced through an aria-live region.
 */
export function ActionForm({
    action,
    children,
    className,
    successMessage,
    onSuccess,
    resetOnSuccess = false
}: {
    action: Action;
    children: React.ReactNode | ((state: ActionState) => React.ReactNode);
    className?: string;
    successMessage?: string;
    onSuccess?: (state: ActionState) => void;
    resetOnSuccess?: boolean;
}) {
    const [state, formAction] = React.useActionState(action, initialActionState);
    const ref = React.useRef<HTMLFormElement>(null);
    const lastAt = React.useRef<number | undefined>(undefined);
    React.useEffect(() => {
        if (state.ok && state.at !== lastAt.current) {
            lastAt.current = state.at;
            if (resetOnSuccess) ref.current?.reset();
            onSuccess?.(state);
        }
    }, [state, onSuccess, resetOnSuccess]);
    return (
        <form ref={ref} action={formAction} className={className} noValidate={false}>
            {typeof children === 'function' ? children(state) : children}
            <div aria-live="polite" className="empty:hidden mt-3">
                {state.error && <ErrorMessage error={state.error} />}
                {state.ok && successMessage && <Alert tone="success" title={successMessage} />}
            </div>
        </form>
    );
}
