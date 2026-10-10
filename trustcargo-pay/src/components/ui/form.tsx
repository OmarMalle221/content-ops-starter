import * as React from 'react';
import { cn } from '@/lib/cn';

const field =
    'w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
    return <input className={cn(field, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
    return <textarea className={cn(field, 'min-h-20 py-2', className)} {...props} />;
}

export function Select({ className, ...props }: React.ComponentProps<'select'>) {
    return <select className={cn(field, 'h-9 pr-8', className)} {...props} />;
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
    return <label className={cn('text-sm font-medium', className)} {...props} />;
}

export function Field({
    label,
    htmlFor,
    hint,
    error,
    children,
    className
}: {
    label: React.ReactNode;
    htmlFor: string;
    hint?: React.ReactNode;
    error?: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn('flex flex-col gap-1.5', className)}>
            <Label htmlFor={htmlFor}>{label}</Label>
            {children}
            {hint && !error && (
                <p className="text-xs text-muted-foreground" id={`${htmlFor}-hint`}>
                    {hint}
                </p>
            )}
            {error && (
                <p className="text-xs text-danger" id={`${htmlFor}-error`} role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

export function Checkbox({ className, ...props }: React.ComponentProps<'input'>) {
    return <input type="checkbox" className={cn('size-4 rounded border-input accent-[var(--color-primary)]', className)} {...props} />;
}
