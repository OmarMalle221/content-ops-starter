import * as React from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: React.ComponentProps<'section'>) {
    return <section className={cn('min-w-0 rounded-lg border bg-card text-card-foreground shadow-xs', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            className={cn('flex flex-col items-start gap-2 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between', className)}
            {...props}
        />
    );
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
    return <h2 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
    return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
    return <div className={cn('px-5 py-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
    return <div className={cn('flex flex-wrap items-center gap-2 border-t px-5 py-3', className)} {...props} />;
}
