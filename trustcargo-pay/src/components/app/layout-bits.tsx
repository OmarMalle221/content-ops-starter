import { FlaskConical } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

export function PageHeader({
    title,
    description,
    actions,
    eyebrow
}: {
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    eyebrow?: React.ReactNode;
}) {
    return (
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 space-y-1">
                {eyebrow && <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>}
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
                {description && <div className="text-sm text-muted-foreground">{description}</div>}
            </div>
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
    );
}

export function EmptyState({
    icon: Icon,
    title,
    children
}: {
    icon?: React.ComponentType<{ className?: string }>;
    title: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
            {Icon && <Icon className="size-8 text-muted-foreground/60" aria-hidden />}
            <p className="text-sm font-medium">{title}</p>
            {children && <div className="text-sm text-muted-foreground">{children}</div>}
        </div>
    );
}

export function DemoBanner({ label, detail }: { label: string; detail: string }) {
    return (
        <div className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft text-warning" role="note">
            <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-1.5 text-xs sm:text-sm">
                <FlaskConical className="size-4 shrink-0" aria-hidden />
                <strong className="font-semibold">{label}</strong>
                <span className="hidden text-foreground/70 md:inline">— {detail}</span>
            </div>
        </div>
    );
}

export function KeyValue({ items, className }: { items: { label: React.ReactNode; value: React.ReactNode }[]; className?: string }) {
    return (
        <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
            {items.map((item, i) => (
                <div key={i} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{item.label}</dt>
                    <dd className="mt-0.5 text-sm font-medium break-words">{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function Stat({ label, value, hint }: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <div className="rounded-lg border bg-card p-4 shadow-xs">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular">{value}</p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
    return <span className={cn('font-mono text-xs break-all', className)}>{children}</span>;
}
