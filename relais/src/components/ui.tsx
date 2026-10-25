import {
    useEffect,
    useId,
    useRef,
    type ButtonHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type SelectHTMLAttributes
} from 'react';

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

// Une navigation « réserve » le focus pour le prochain titre de page, même s'il n'apparaît qu'une fois
// les données chargées (voir RouteFocus dans AppLayout).
let titleFocusRequested = false;

const isTyping = () => document.activeElement?.matches('input, textarea, select, [contenteditable]') ?? false;

/** Appelé à chaque changement d'adresse : le titre affiché (ou le prochain) recevra le focus. */
export function requestPageTitleFocus(): void {
    titleFocusRequested = true;
    const current = document.querySelector<HTMLElement>('[data-page-title]');
    if (current && !isTyping()) {
        current.focus();
        titleFocusRequested = false;
    }
}

/**
 * Titre de page : reçoit le focus après chaque navigation, et aussi quand une étape en remplace une autre
 * sans changer d'adresse (le focus, resté sur un bouton disparu, serait perdu). Jamais pendant une saisie.
 */
export function PageTitle({ children }: { children: ReactNode }) {
    const ref = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        const lost = document.activeElement === null || document.activeElement === document.body;
        if ((titleFocusRequested || lost) && !isTyping()) {
            ref.current?.focus();
            titleFocusRequested = false;
        }
    }, []);
    // Titre de l'onglet : celui de la page (les lecteurs d'écran l'annoncent aussi).
    useEffect(() => {
        if (typeof children === 'string') document.title = children === 'Relais' ? 'Relais' : `${children} — Relais`;
    }, [children]);
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

export function SelectField({
    label,
    hint,
    options,
    ...select
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; options: Array<{ value: string; label: string }> }) {
    const id = useId();
    return (
        <div className="flex flex-col gap-1">
            <label htmlFor={id} className="font-bold">
                {label}
            </label>
            {hint && (
                <p id={`${id}-hint`} className="text-muted">
                    {hint}
                </p>
            )}
            <select
                id={id}
                aria-describedby={hint ? `${id}-hint` : undefined}
                className="min-h-12 rounded-lg border-2 border-muted bg-surface px-3 text-lg"
                {...select}
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

export function Checkbox({ label, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
    return (
        <label className="flex min-h-12 cursor-pointer items-center gap-3">
            <input type="checkbox" className="size-6 shrink-0 accent-brand" {...input} />
            <span>{label}</span>
        </label>
    );
}

/** Groupe de boutons radio (fieldset + legend), avec une description facultative par option. */
export function RadioGroup<T extends string>({
    legend,
    name,
    value,
    options,
    onChange,
    error
}: {
    legend: string;
    name: string;
    value: T | null;
    options: Array<{ value: T; label: string; description?: string }>;
    onChange: (value: T) => void;
    error?: string | null;
}) {
    const id = useId();
    return (
        <fieldset className="flex flex-col gap-2" aria-describedby={error ? `${id}-error` : undefined}>
            <legend className="mb-1 font-bold">{legend}</legend>
            {error && (
                <p id={`${id}-error`} className="font-bold text-urgent">
                    {error}
                </p>
            )}
            {options.map((option) => (
                <label
                    key={option.value}
                    className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-3"
                >
                    <input
                        type="radio"
                        className="mt-1 size-5 shrink-0 accent-brand"
                        name={name}
                        value={option.value}
                        checked={value === option.value}
                        onChange={() => onChange(option.value)}
                    />
                    <span>
                        <span className="font-bold">{option.label}</span>
                        {option.description && <span className="block text-muted">{option.description}</span>}
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

export function Loading() {
    return (
        <p role="status" className="py-8 text-center text-muted">
            Chargement…
        </p>
    );
}
