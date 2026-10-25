import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

const BUTTON_BASE =
    'inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-5 py-2 text-base font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const BUTTON_VARIANTS = {
    primary: 'bg-brand text-white hover:bg-brand-strong',
    secondary: 'border-2 border-brand bg-surface text-brand hover:bg-brand-soft',
    danger: 'bg-urgent text-white hover:bg-urgent-strong',
    quiet: 'text-brand underline underline-offset-4 hover:text-brand-strong'
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
    return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${extra}`.trim();
}

export function Button({
    variant = 'primary',
    className = '',
    type = 'button',
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
    return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

/**
 * Titre de page : reçoit le focus après chaque navigation (voir RouteFocus), et aussi quand une étape
 * en remplace une autre sans changer d'adresse (le focus, resté sur un bouton disparu, serait perdu).
 */
export function PageTitle({ children }: { children: ReactNode }) {
    const ref = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        if (document.activeElement === null || document.activeElement === document.body) ref.current?.focus();
    }, []);
    return (
        <h1 ref={ref} tabIndex={-1} data-page-title className="text-3xl font-bold text-brand-strong">
            {children}
        </h1>
    );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <section className={`rounded-xl border border-line bg-surface p-5 ${className}`}>{children}</section>;
}

/** Message d'erreur (role=alert) ou de confirmation (role=status), annoncé par les lecteurs d'écran. */
export function Notice({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
    const styles = {
        error: 'border-urgent bg-urgent-soft',
        success: 'border-ok bg-ok-soft',
        info: 'border-brand bg-brand-soft'
    }[tone];
    return (
        <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border-l-4 p-4 ${styles}`}>
            {children}
        </div>
    );
}

export function TextField({
    label,
    hint,
    error,
    ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null }) {
    const id = useId();
    const hintId = hint ? `${id}-hint` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    return (
        <div className="flex flex-col gap-1">
            <label htmlFor={id} className="font-bold">
                {label}
            </label>
            {hint && (
                <p id={hintId} className="text-muted">
                    {hint}
                </p>
            )}
            {error && (
                <p id={errorId} className="font-bold text-urgent">
                    {error}
                </p>
            )}
            <input
                id={id}
                aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
                aria-invalid={error ? true : undefined}
                className={`min-h-12 rounded-lg border-2 bg-surface px-3 text-lg ${error ? 'border-urgent' : 'border-muted'}`}
                {...input}
            />
        </div>
    );
}

export function Loading() {
    return (
        <p role="status" className="py-8 text-center text-muted">
            Chargement…
        </p>
    );
}
